---
title: "Embeddings"
description: "Configure Ollama, LM Studio, or OpenAI embeddings for Journal and BuJo semantic recall, including validation, timeouts, and circuit breaking."
sidebar:
  order: 1
---

The `memory.embeddings` block configures the vector embedding provider used for semantic
recall. It is a **shared prerequisite** for both the `journal` and `bujo` memory tiers — it
is not a tier on its own. The `lite` tier needs no embeddings. This page covers the config
keys, the three providers (Ollama, LM Studio, and OpenAI), the matching `MONO_AGENT_MEMORY_EMBEDDINGS_*`
env vars, and the timeout / circuit-breaker behavior.

For the tier model (lite / journal / bujo) and where this block fits, see
[the memory overview](/memory/). For how recall actually uses these embeddings at runtime, see
[memory capture and recall](/memory/capture-and-recall/).

Coverage: **config**. The standalone maintenance CLI can also enable embeddings via env vars
(see [memory validation and CLI operations](/memory/validation-and-cli/)).

## When you need it

| Tier | Requires embeddings |
| --- | --- |
| `lite` | no |
| `journal` | **yes** |
| `bujo` | **yes** |

Both `journal` and `bujo` perform hybrid recall (BM25 keyword + vector RRF). Without a
configured `memory.embeddings` block, those tiers fail config validation — there is no
silent fallback.

Journal commits and hash-deduplicates its lexical row before scheduling semantic work. Vector
indexing runs in a bounded background queue (up to 256 items / 2 MiB, batches of 32), so a slow
or failed embedding request is never on the successful agent-turn critical path. The lexical row
remains recallable and the missing-vector backlog is retried. BuJo likewise performs embedding
work inside its bounded background curation queue rather than delaying the channel reply.

## Configuration keys

| Key | Type | Required | Notes |
| --- | --- | --- | --- |
| `provider` | `"ollama"` \| `"lmstudio"` \| `"openai"` | yes | Selects exactly one embedding backend; requests never fall through to another provider. |
| `model` | string | yes | Exact model tag (see below). |
| `endpoint` | string | no | Absolute HTTP(S) service root. It may include a path, but not credentials, a query, or a fragment. Defaults to `http://localhost:11434` (Ollama), `http://localhost:1234` (LM Studio), or `https://api.openai.com/v1` (OpenAI). |
| `apiKeyEnv` | string | OpenAI; optional LM Studio | Name of the env var holding the API key (preferred). LM Studio is keyless when omitted. |
| `apiKey` | string | OpenAI; optional LM Studio | Inline key (prefer `apiKeyEnv`; keep secret values out of config). |
| `dim` | number | yes | Output dimension; must match the model (768 for `nomic-embed-text:v1.5`, 1536 for `text-embedding-3-small`). |

:::caution
The `model` and `dim` must agree with the actual model. A mismatched `dim` corrupts the
vector index. For OpenAI, supply the key via `apiKeyEnv`; inline `apiKey` remains
schema-compatible for existing consumers, but source configs keep secret values out of
config. One of the two fields is required. LM Studio is keyless by default. If its config
declares `apiKeyEnv`, that variable must contain a non-empty value: validation reports
`waiting` and guided readiness does not silently retry keyless when the declared variable
is missing.
:::

## Guided Journal/BuJo setup

On an interactive `mono-agent init`, choosing Journal or BuJo opens a dedicated embeddings
step. Choose **Ollama** or **LM Studio**, then confirm the service root, exact model,
actual vector dimension, and (when needed) the name of an API-key environment variable.
This catalog is independent from runtime chat-model discovery:

- Ollama enumerates `GET /api/tags`, then retains only models whose `POST /api/show`
  response lists the exact `embedding` capability.
- LM Studio reads `GET /api/v1/models`, retains entries whose exact `type` is
  `embedding`, and stores the returned `key` as the model id.
- The wizard sends one fixed, non-user probe through Ollama `/api/embed` or LM Studio
  `/v1/embeddings`, verifies a non-empty finite numeric vector, and records its actual
  dimension.

If typed discovery is unavailable or inconclusive, the wizard lets you enter an exact model
id and positive dimension manually. That escape hatch only authors the config: the
first-run readiness gate must still complete a real embedding probe before it can report
**Agent ready**. Provider failures never trigger an Ollama↔LM Studio fallback.

Flag/non-TTY scaffolding remains deterministic and non-probing: Journal/BuJo use Ollama at
`http://localhost:11434`, model `nomic-embed-text:v1.5`, and dimension `768` unless you edit
the generated config. The interactive wizard records all four identity fields explicitly.

## Ollama (local, no API key)

Local embeddings via Ollama's `/api/embed` endpoint. No key needed. Pull the model first —
use the **exact `:v1.5` tag**; the bare alias `nomic-embed-text` may not exist in your
install and will fail the embeddings provider at startup. `mono-agent validate` checks for
this exact tag.

```bash
ollama pull nomic-embed-text:v1.5
```

```json
{
  "memory": {
    "mode": "journal",
    "path": "./.mono-agent/memory",
    "embeddings": {
      "provider": "ollama",
      "model": "nomic-embed-text:v1.5",
      "endpoint": "http://localhost:11434",
      "dim": 768
    }
  }
}
```

## LM Studio (local, optional API key)

Load an embedding model in LM Studio and start its local server. Use the service root—not
`/v1`—because mono-agent appends `/v1/embeddings` itself. The model must be the exact `key`
reported by LM Studio's typed `/api/v1/models` response.

```json
{
  "memory": {
    "mode": "journal",
    "path": "./.mono-agent/memory",
    "embeddings": {
      "provider": "lmstudio",
      "model": "text-embedding-nomic-embed-text-v1.5",
      "endpoint": "http://localhost:1234",
      "dim": 768
    }
  }
}
```

LM Studio is keyless unless server authentication is enabled. For an authenticated server,
add only the environment-variable name to config, for example
`"apiKeyEnv": "LM_STUDIO_API_KEY"`, and put the value in the agent's owner-only `.env`.
Do not add a dummy key for a keyless server.

## OpenAI (hosted, API key required)

```json
{
  "memory": {
    "mode": "bujo",
    "path": "./.mono-agent/memory",
    "embeddings": {
      "provider": "openai",
      "model": "text-embedding-3-small",
      "apiKeyEnv": "OPENAI_API_KEY",
      "dim": 1536
    }
  }
}
```

Set the key in the environment that `apiKeyEnv` names:

```bash
export OPENAI_API_KEY=sk-...
```

The default OpenAI endpoint is `https://api.openai.com/v1`; override `endpoint` to target an
OpenAI-compatible gateway.

## Environment variables

Every key has a `MONO_AGENT_MEMORY_EMBEDDINGS_*` override. See
[the environment-variable reference](/config/env-vars/).

| Env var | Config key |
| --- | --- |
| `MONO_AGENT_MEMORY_EMBEDDINGS_PROVIDER` | `memory.embeddings.provider` |
| `MONO_AGENT_MEMORY_EMBEDDINGS_MODEL` | `memory.embeddings.model` |
| `MONO_AGENT_MEMORY_EMBEDDINGS_ENDPOINT` | `memory.embeddings.endpoint` |
| `MONO_AGENT_MEMORY_EMBEDDINGS_DIM` | `memory.embeddings.dim` |
| `MONO_AGENT_MEMORY_EMBEDDINGS_API_KEY_ENV` | `memory.embeddings.apiKeyEnv` |
| `MONO_AGENT_MEMORY_EMBEDDINGS_API_KEY` | `memory.embeddings.apiKey` |

The standalone `memory-bujo` CLI that read these `MONO_AGENT_MEMORY_EMBEDDINGS_*` variables
directly against a memory root has been removed. Config-aware recall now runs from the agent
folder with `mono-agent memory search`, which reads the configured embeddings provider, model,
and dimension from `mono-agent.config.json`; when local embeddings are unavailable it falls back
to FTS-only recall instead of pretending semantic search succeeded. Rebuild and rollback are
likewise config-aware — `mono-agent memory rebuild` / `rollback` — and take their tier and
embeddings identity from config, so there is no `--tier` flag or standalone env workflow. See
[Validation & CLI](/memory/validation-and-cli/#memory-bujo-cli--removed).

## Timeout and circuit-breaker behavior

In a config-first host, each embedding request has a **10 s** timeout by default.
Embedding calls are also wrapped in a circuit breaker so a slow or failing embedding service
cannot stall recall:

- A timeout (`AbortError`) or structurally identified network `TypeError` is reported as
  `MemorySearchError` with code `embedding_request_failed`, retaining the original error as
  `cause`. Network classification requires a known transport code in a bounded `Error` cause
  graph, including aggregate failures; unstructured `TypeError`, other adapter failures, and
  response-validation failures preserve their existing identity and taxonomy.

- After **3 consecutive failures** the breaker trips **OPEN** and fails fast, throwing
  `embedding_circuit_open` instead of waiting on the unhealthy backend.
- It stays OPEN for a **30 s cooldown**, then allows a single **HALF-OPEN** trial request.
- A successful trial closes the breaker; a failed trial re-opens it for a fresh cooldown.

:::note
The config-first defaults and overrides are:

| Config key | Default | Environment override |
| --- | --- | --- |
| `memory.embeddings.timeoutMs` | `10000` | `MONO_AGENT_MEMORY_EMBEDDINGS_TIMEOUT_MS` |
| `memory.embeddings.circuitBreaker.failureThreshold` | `3` | `MONO_AGENT_MEMORY_EMBEDDINGS_CIRCUIT_BREAKER_FAILURE_THRESHOLD` |
| `memory.embeddings.circuitBreaker.cooldownMs` | `30000` | `MONO_AGENT_MEMORY_EMBEDDINGS_CIRCUIT_BREAKER_COOLDOWN_MS` |

The low-level `@mono-agent/memory/search` provider constructor retains its own 30-second
timeout when called directly without `timeoutMs`; the configured app always supplies the
resolved 10-second default. Programmatic callers can tune the same values through
`createEmbeddingProvider` and `createCircuitBreakerEmbeddingProvider`; see the
[programmatic API overview](/programmatic/).
:::

## Validation

`mono-agent validate` checks the configured provider only. Ollama validation checks typed
capability metadata and the real `/api/embed` response. LM Studio checks the typed
`/api/v1/models` entry and real `/v1/embeddings` response. Both require the returned vector
dimension to equal config. OpenAI keeps its credential/config validation and is not offered
as the guided local-memory choice. See [memory validation and CLI operations](/memory/validation-and-cli/).

Changing the configured provider, model, or dimension changes the managed index identity.
Stop the agent, edit config, run `mono-agent memory rebuild --json`, validate, then restart;
never relabel an existing generation by hand. See the safe rebuild procedure in
[safe index-generation rebuild and rollback](/memory/validation-and-cli/#safe-index-generations-rebuild-and-rollback).

---
title: "Local BuJo memory"
description: "Configure the owner-private BuJo store, runtime-backed capture, deterministic recall, and explicit migration rehearsal."
sidebar:
  order: 0
---

`@mono-agent/memory-local` is the single first-party memory implementation.
It owns owner-private SQLite recall, completed-turn capture, forgetting,
consolidation, and maintenance. Select it in the singleton `memory` slot:

```json
{
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
  }
}
```

The selected module schema is strict. `root` resolves relative to the agent
config; `maxBytes` bounds returned memory text; `capture.model` is required
when capture is enabled; `embeddings` is optional; and `recallTool.enabled`
controls model-visible recall without deleting the store. Omit embeddings for
FTS-only recall.

## Permanent first-run identity

A new root permanently retains `.first-run-memory-initializing`. The module
creates it exclusively as an owner-owned, single-link, `0600` regular file,
writes `initializing:<uuid>`, and changes the same pinned inode to
`initialized:<same-uuid>` only after the database is durable. It never renames,
replaces, or unlinks the marker.

Unsafe ownership, mode, type, link count, descriptor identity, malformed
marker, in-flight initialization, schema, or integrity state fails closed.
The module does not path-chmod or silently repair operator data.

## Capture, recall, and maintenance

Capture routes each completed turn through the selected runtime and model. A
provider, schema, embedding, or timeout failure leaves bounded durable intake
for explicit retry. Recall uses bounded FTS candidates and can combine matching
Ollama vectors; embedding failure degrades to FTS, never invented matches.

With `recallTool.enabled: true`, Core exposes
`MemoryRecall({ "query": "...", "limit": 8 })` on tool-capable routes. `query`
is required, trimmed, and bounded to 64 KiB UTF-8; `limit` defaults to 8 and is
bounded from 1 through 50. Results contain text-only records plus an
untrusted-evidence warning, never module-private record metadata. The tool is
read-only, approval-free, subject to global and request-local tool policy, and
bound to the active conversation and turn cancellation signal.
Use active conversation history—not durable recall—for current or last-message
questions. Setting the flag to `false` removes the model-visible tool while
leaving automatic pre-turn recall available. Core always reserves the exact
`MemoryRecall` name against MCP and channel impersonation.

Audit, backup, consolidation, rebuild, forget preview/confirmation, and intake
retry remain explicit package operations. Running hosts expose the namespaced
`memory-local:retry` command with an optional limit from 1 through 1,000. The
one-shot `mono-agent memory` route creates only the selected memory module, so
it can run store-only maintenance but cannot recover runtime-backed capture
intake; issue that retry through an AgentHost with the configured runtime
loaded and `lifecycleTimeoutMs` at least as large as the configured
`capture.timeoutMs`. A default 10-second host cannot recover a slower capture.
`mono-agent doctor` performs read-only diagnostics and never captures, retries,
rebuilds, consolidates, or repairs data.

## Data-adoption boundary

Never point a source-preview build at the only copy of application state. Stop
writers, audit and back up the source, rehearse against a complete copy, compare
recall and capture behavior, prove duplicate admission and destructive-operation
confirmation, then retain the verified backup through rollback.

Conversation history, run artifacts, native runtime sessions, and web threads
are not imported automatically. Any later adoption needs an explicit,
consumer-specific data map and rollback proof.

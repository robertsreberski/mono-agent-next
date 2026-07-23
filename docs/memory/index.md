---
title: "Memory"
description: "Configure the v1 owner-private BuJo store, deterministic consolidation, optional Ollama vectors, runtime-backed capture, recall, and explicit migration rehearsal."
sidebar:
  order: 0
---

V1 has one first-party memory implementation:
`@mono-agent/memory-local`. It owns an owner-private BuJo SQLite store, FTS
recall, optional Ollama vectors, completed-turn capture, forgetting, and the
projection-only consolidation and maintenance needed to adopt an existing BuJo
root safely.

Lite, Journal, `memory.mode`, `memory.path`, `memory.writeMode`,
`memory.llm`, and automatic consolidation scheduling are not v1 configuration.
Consolidation remains an explicit package maintenance operation. A different
memory algorithm belongs in a separately selected memory module.

## Configuration

Select the module in the singleton `memory` slot:

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

The selected module schema is strict and rejects unknown fields.

| Field | Contract |
| --- | --- |
| `root` | Optional store root. A relative value resolves from the agent-config directory; omission uses Core's instance-specific data directory. |
| `maxBytes` | Maximum UTF-8 memory text returned by one recall. Default `96000`; accepted range `1024`–`4194304`. |
| `capture.enabled` | Defaults to `false`. When false, omit `capture.model`; the existing store remains available for recall. |
| `capture.model` | Required when capture is enabled. References one configured runtime instance and one runtime-owned model id. |
| `capture.timeoutMs` | Per runtime-backed capture attempt. Default `360000`; accepted range `1`–`3600000`. |
| `embeddings` | Optional Ollama vector configuration. Omit it for FTS-only recall. |
| `recallTool.enabled` | Controls model-visible recall and defaults to `true`; it does not delete or disable the store. |

The Ollama block requires `provider`, `endpoint`, `model`, and `dimensions`.
`endpoint` must be HTTPS or literal-loopback HTTP, without credentials, a
query, or a fragment. Optional operational bounds are
`timeoutMs` (default `30000`), `breakerFailures` (default `3`), and
`breakerResetMs` (default `30000`).

## Persistence and safety

The store uses one BuJo SQLite schema with FTS5 and optional `sqlite-vec`.
It acquires a separate SQLite writer lease and validates the root, marker, and
database before each durability-sensitive operation.

A new root permanently retains
`.first-run-memory-initializing`. The module creates that file exclusively,
writes `initializing:<uuid>\n`, and changes it to
`initialized:<same-uuid>\n` through the same pinned descriptor only after the
database is durable. It never renames, replaces, or unlinks the marker.

For a pre-existing `memory.db`, the module fails closed unless descriptor-based
checks prove a regular, owner-owned, single-link file with exact mode `0600`
and stable device/inode identity. It does not path-chmod or silently repair
operator data. Symlink, path-swap, malformed marker, in-flight initialization,
schema, or integrity failures remain explicit.

## Capture and recall

When capture is enabled, Core submits each completed-turn memory record through
the selected runtime/model route. The request carries a JSON schema, a bounded
output-token budget, and `capture.timeoutMs`. A valid extraction is committed
with an idempotent receipt. A provider, schema, embedding, or timeout failure
leaves bounded durable intake for explicit retry; it is never reported as
successful capture.

Recall always uses bounded FTS candidates. When Ollama embeddings are
configured and their identity matches the store, recall combines FTS and vector
ranks with deterministic ordering. Provider failure or an open circuit breaker
degrades to FTS instead of returning invented semantic matches.

See [Capture and recall](/memory/capture-and-recall/) for the runtime boundary,
failure behavior, and recall controls.

## Explicit maintenance

Maintenance is an operator action, not startup-time repair:

| Operation | Purpose |
| --- | --- |
| `audit({ strict: true })` | Prove marker/database identity, schema, FTS/vector coverage, and empty durable intake. Strict audit fails when the store is degraded. |
| `previewForget(recordId, signal)` | Show the exact record and whether a vector exists before a destructive forget. |
| `backup({ destinationDirectory, signal })` | Write a verified backup into a separate empty owner-private directory and return database/marker SHA-256 evidence. |
| `consolidate({ signal })` | Read canonical BuJo rows, report normalized duplicate groups, and refresh bounded `index.md` plus deterministic `future-log.md` projections without model, embedding, or canonical writes. |
| `rebuild({ signal })` | Recreate FTS and, when configured, vectors from canonical records. |
| `forget({ recordId, signal })` | Invalidate one explicit record id. |
| `retryIntake({ signal, limit? })` | Retry bounded failed capture and vector work. |

These methods are exported by `MemoryLocal`; `openMemoryLocal` is the explicit
entry point for an inspection or migration-rehearsal process. Open the store
only when the agent using that root is stopped, so the package-owned writer
lease remains authoritative.

The same methods are available through the configured memory module's
namespaced commands:

```bash
mono-agent memory memory-local:audit --config ./mono-agent.config.json \
  --input-json '{"strict":true}'
mono-agent memory memory-local:consolidate --config ./mono-agent.config.json
mono-agent memory memory-local:backup --config ./mono-agent.config.json \
  --input-json '{"destinationDirectory":"./memory-backup"}'
mono-agent memory memory-local:rebuild --config ./mono-agent.config.json \
  --input-json '{"confirm":true}'
mono-agent memory memory-local:forget --config ./mono-agent.config.json \
  --input-json '{"recordId":"runtime:..."}'
```

Forget is preview-only when `dryRun` is omitted or true. Mutation requires the
unambiguous input `{"recordId":"...","dryRun":false,"confirm":true}`.
Rebuild likewise rejects omitted, false, or ambiguous confirmation. Audit
labels each projection `ready`, `missing`, `unsafe`, or `invalid`: two missing
files are a coherent never-consolidated store, while a one-file publication or
an unsafe/invalid target degrades strict audit without repairing it.

Consolidation publishes the constant `future-log.md` companion first and
`index.md` last as the semantic commit. A crash before that commit leaves the
old index authoritative; the incomplete first-publication state is visible to
audit and an explicit retry completes it. This protocol relies on future-log
remaining constant; a future variable companion would require a manifest or
journaled generation.

`mono-agent doctor` invokes the module's non-serving diagnostics callback
without starting it. The callback reuses this read-only audit: healthy memory
adds no finding; pending FTS, vector, intake, or projection state adds bounded
warnings/errors; and an identity, integrity, corruption, or in-flight-marker
failure produces one sanitized error. Diagnostics never capture, call a model
or embedding provider, retry intake, consolidate, rebuild, or repair files.

## Migration rehearsal and rollback

BuJo is the only v0 application state adopted as canonical by v1. Never point a
beta at the only live copy.

For each consumer:

1. Stop writers and run a strict audit of the source.
2. Create and retain a verified backup.
3. Rehearse on a separate copy, leaving the source unchanged.
4. Compare representative FTS recall and, when configured, vector recall.
5. Prove capture, exact duplicate admission, forget preview, intake retry, and
   rebuild on the rehearsal copy.
6. Run explicit consolidation twice; compare byte-identical projections and
   duplicate-group evidence, then rehearse an interrupted pre-commit retry.
7. Prove both the frozen v0 reader and the v1 reader against the copied data.
8. Run a final strict audit before cutover and retain the verified backup
   through the rollback window.

An unsafe file type, owner, mode, link target, descriptor identity, integrity
failure, format mutation, or unresolved intake blocks adoption. Remediation
and restoring a backup are explicit operator filesystem procedures outside
`memory-local`; the module will not mutate an unsafe source to make it pass.

Release, live cutover, soak, and predecessor retirement remain a separate
phase from source implementation.

## Related

- [Capture and recall](/memory/capture-and-recall/)
- [V1 architecture](/reference/v1-architecture/)
- [Feature registry](/reference/feature-registry/)

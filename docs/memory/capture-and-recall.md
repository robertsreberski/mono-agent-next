---
title: "Capture and recall"
description: "Understand v1 runtime-backed BuJo capture, durable retry intake, FTS and optional vector recall, and the MemoryRecall control."
sidebar:
  order: 2
---

`@mono-agent/memory-local` has one write mode: schema-constrained BuJo capture,
enabled explicitly with `memory.capture.enabled`. Disable capture to keep an
existing store recall-only.

## Capture configuration

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
    "recallTool": {
      "enabled": true
    }
  }
}
```

`capture.model.runtime` must name a configured runtime instance.
`capture.model.model` is validated by that runtime. The capture route is
independent from the primary conversation route.

For recall without new writes:

```json
{
  "memory": {
    "$use": "@mono-agent/memory-local",
    "root": "./.mono-agent/memory",
    "capture": {
      "enabled": false
    },
    "recallTool": {
      "enabled": true
    }
  }
}
```

When `capture.enabled` is false, `capture.model` must be omitted.

## Capture — per-turn intelligent capture (BuJo)

Memory capture does not invoke a provider SDK directly. The module requests the
bounded `memory.runtime-capture` host capability with:

- the configured runtime instance and model;
- one exact JSON response schema;
- a maximum of eight extracted records;
- a bounded output-token budget; and
- the configured per-attempt timeout.

Core performs ordinary route and capability validation. A runtime that cannot
honor structured output or the requested output-token bound is ineligible
rather than receiving a looser prompt.

On `@mono-agent/runtime-pi`, a `responseSchema` turn uses one internal,
terminating Pi tool whose parameter schema is the requested output schema.
Pi's runtime-owned `NodeRepl`, `Edit`, and `WebSearch` tools are removed for
that turn, so no native-tool approval callback is needed. Core-owned request
tools remain under Core's tool policy. The internal schema-tool call is not
emitted as a model-visible tool event. Loose JSON text, no schema-tool call, or
a second submission fails closed.

`maxOutputTokens` is honored by capping Pi's model output budget to the smaller
of the requested value and the model's own maximum.

## Durable and idempotent writes

A completed-turn record has a stable id and content hash. Before extraction,
`memory-local` records bounded durable intake. Successful extraction,
BuJo/FTS publication, optional vector work, and the capture receipt converge
under that identity:

- an exact retry is a successful no-op;
- reuse of the id with different content fails closed;
- invalid or partial structured output is not treated as an empty success;
- runtime/provider details are sanitized at the public error boundary; and
- failed capture or vector work remains visible to audit and available to
  `retryIntake`.

Capture, forgetting, rebuild, and retry serialize through the store's exclusive
writer lease. Stopping or restarting does not turn pending intake into a
successful receipt.

## Entity graph (BuJo, auto)

There is no automatic entity-graph extraction in the v1 capture schema.
Runtime-backed capture extracts one to eight standalone fact texts. The BuJo
database retains its entity and relationship tables so audited v0 BuJo data
remains readable, but v1 capture does not invent or broaden those associations.

## FTS and optional vector recall

FTS recall is always available for a healthy store. To add semantic candidates,
configure Ollama:

```json
{
  "embeddings": {
    "provider": "ollama",
    "endpoint": "http://127.0.0.1:11434",
    "model": "nomic-embed-text:v1.5",
    "dimensions": 768,
    "timeoutMs": 30000,
    "breakerFailures": 3,
    "breakerResetMs": 30000
  }
}
```

The provider calls Ollama's bounded `/api/embed` endpoint without redirects and
requires finite vectors of exactly `dimensions`. Recall combines FTS and vector
ranks when the configured embedding identity matches the store. A provider
failure, circuit-breaker interval, or vector-identity mismatch degrades to FTS;
`audit` reports the degraded vector state and `rebuild` repairs it after the
configured provider is ready.

Recall accepts at most 50 results and never returns more memory text than
`memory.maxBytes`. Stable score, creation time, and record-id ordering make
equal inputs deterministic.

## Projection-only consolidation

`MemoryLocal.consolidate({ signal })`, or the
`memory-local:consolidate` maintenance command, performs no capture-model or
embedding call. It scans at most the store's fixed 100,000-record capacity,
reports normalized duplicate groups without folding them, and refreshes a
bounded top-memory/entity `index.md` plus the deterministic empty
`future-log.md`. Canonical memory, graph, FTS, vectors, receipts, and intake are
read-only inputs.

The package writer lease and in-process write queue serialize consolidation
with capture, forget, rebuild, and retry. Projection files are staged as
owner-only, single-link regular files. The constant future-log publishes first;
`index.md` is the semantic commit. A failure before that commit leaves the
prior index authoritative, returns a sanitized retryable error, and never
promotes the failure to a successful maintenance result.

## Model-visible recall

`memory.recallTool.enabled` defaults to `true`. It controls whether Core exposes
the selected memory module's request-scoped read-only recall tool to the model.
Set it to `false` to hide that tool without disabling host-side storage,
inspection, maintenance, or future re-enablement.

The tool reads the same store as capture. It does not call the capture model and
does not edit memory.

## Failure and operator response

| Symptom | Safe response |
| --- | --- |
| Capture intake pending | Keep the source data; correct the runtime/model issue, then run bounded `retryIntake`. |
| Vector intake pending or identity mismatch | Restore Ollama/model/dimensions, then run `rebuild` or bounded retry as appropriate. |
| Strict audit fails | Do not cut over. Preserve the root and backup, then investigate on a copy. |
| Projection pair is incomplete or unsafe | Preserve canonical rows, correct only the derived target on a copy, then rerun explicit consolidation and strict audit. |
| Forget requested | Run `previewForget` first, then forget one explicit record id. |
| Migration planned | Follow the copied-data rehearsal and rollback sequence in the [Memory overview](/memory/#migration-rehearsal-and-rollback). |

The module never silently path-chmods, replaces, or repairs unsafe pre-existing
operator data.

## Related

- [Memory overview](/memory/)
- [Feature registry](/reference/feature-registry/)
- [V1 architecture](/reference/v1-architecture/)

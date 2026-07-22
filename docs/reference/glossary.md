---
title: "Glossary"
description: "Look up the framework, configuration, runtime, channel, memory, and observability terms used in these docs."
sidebar:
  order: 3
---

Definitions of the core terms used throughout the mono-agent docs and config. Each entry is one to three sentences; most link to the page that covers the concept in depth. Where a term maps to a config key, the exact key and `MONO_AGENT_*` env var are shown.

## A2A

The Agent-to-Agent protocol: a JSON-RPC + REST wire format (with optional streaming and bearer auth) for one agent to discover and call another over HTTP. mono-agent can act as an A2A **provider** (`config.provider.*` under the `@mono-agent/a2a-adapter` plugin entry) and as an A2A **consumer** (`config.consumer.*` under the same plugin entry). See [A2A channel](/channels/a2a/) and the [A2A consumer (programmatic)](/programmatic/a2a-consumer/).

## Adapter

A package that bridges one transport (Slack, Telegram, WhatsApp, etc.) to the responder. `@mono-agent/*-adapter` packages are composed by `@mono-agent/agent-app` and own their own per-conversation admission, attachment downloads, and outbound delivery. See [Channels](/channels/).

## Agent Card

The discovery document an A2A provider publishes describing its name, version, provider org, and advertised skill. It is populated from plugin `config.agent.*` and `config.skill.*` and is what remote consumers fetch before calling you. See [A2A channel](/channels/a2a/).

## Backend

The underlying runtime/provider that actually runs the model. mono-agent supports multiple backends — `claude` (sdk/cli), `codex` (cli), `pi` (sdk, 15+ providers), and `opencode` (cli) — selected through the [model reference](#model-reference). See [Backends](/runtime/backends/).

## Bloat guard

The automatic 256KB truncation of oversized tool output, with each original block offered to a separate best-effort artifact sink instead of being inlined into context. It is built in (coverage: `auto`); successfully saved blocks land under `artifacts.dir/tool-output/`, while a missing or failed sink leaves only the compact truncation summary. Images get a separate, larger budget. See [Tools and guards](/runtime/tools-and-guards/).

## BuJo

The richest memory tier (`memory.mode: "bujo"`), modeled on the Bullet Journal method: a raw audit outside recall, bounded LLM curation (one extraction plus at most one batch reconcile), an [entity graph](#entity-graph), scheduled lightweight consolidation, a living `index.md`, and a retired empty `future-log.md` stub. It strictly requires an embeddings provider and a chat model. See [Capture and recall](/memory/capture-and-recall/).

## Channel driver

The composable factory behind an adapter (e.g. `createTelegramChannelDriver`, or a package-root `createChannelDriver()` loaded from `channels.plugins[]`) that wires a transport's streaming, message texts, and activity indicators to the responder. Stream/message tuning is configured here (coverage: `code`), while external channel packages can be loaded by config. See [Write your own channel adapter](/programmatic/custom-channels/).

## Context compaction

When a turn approaches the model's context window, the pi bridge drives `AgentHarness.compact()` — proactively at a model-window-derived trigger and reactively with one re-prompt only after a preview proves positive reduction. Rejected previews are not persisted. Configure the adaptive policy through `runtime.compaction.*`; numeric and generic provider overflows lower a learned process-local ceiling. Runs report request estimates and before/after effectiveness. Persistent overflow is `context_limit` and may advance to the next configured fallback. See [Tools and guards](/runtime/tools-and-guards/).

## Entity graph

A BuJo-tier structure that tracks the people, projects, and things explicitly associated with individual curated memories and their relationships. Explicit `MemoryRecall` may expand one deterministic hop; automatic recall stays direct-only. It is built only in `memory.mode: "bujo"`. See [Capture and recall](/memory/capture-and-recall/#entity-graph-bujo-auto).

## Fail-closed

The default-deny posture. It survives in two places: the **programmatic** harness default for code-defined agents (`failClosedToolPolicy()` — a harness built with no policy exposes **no** tools; coverage: `auto`), and the sandbox stance (`sandbox.fallback: "fail-closed"` refuses to run rather than falling back to the host). Note the **config** default is the opposite — an omitted `tools.allowedTools` allows every tool (`tool-policy.allow-all`); a deliberate chat-only agent uses an explicit `tools.allowedTools: []`. See [Tool policy](/tools/policy/) and [Sandbox](/tools/sandbox/).

## Fallback router

The retry layer that walks ordered canonical `{model, effort?}` routes after fallback-eligible provider/auth failures. It records failover and safety history, keeps the chain provider-session-stateless, and carries bounded transcript context between attempts. Configured via `runtime.fallbacks` (`MONO_AGENT_FALLBACKS_JSON`); legacy `runtime.fallbackModels` remains compatible.

```json
{
  "runtime": {
    "model": "pi:openai-codex:gpt-5.6-terra",
    "fallbacks": [
      { "model": "codex:gpt-5.6-sol", "effort": "xhigh" },
      { "model": "pi:ollama:gemma4:31b" }
    ],
    "routeSafety": "per-route-native"
  }
}
```

`routeSafety: "uniform"` (default) requires one compatible monotonic contract.
Explicit `per-route-native` isolates mixed providers and applies their documented
native contracts; unsupported capabilities skip/fail rather than disappearing.

See [Fallback](/runtime/fallback/).

## Harness

The execution engine (`@mono-agent/agent-harness`) that runs a single turn against a backend, applies tool policy and guards, drives compaction, and returns an explicit result or failure object (it never fakes success). The run path begins at `responder.respond`. See [Tools and guards](/runtime/tools-and-guards/).

## Model reference

The string that names a backend and model together, in the form `backend:model` (or `backend:provider:model` for pi). Examples: `pi:openai-codex:gpt-5.6-terra`, `pi:opencode-go:kimi-k2.6`, `codex:gpt-5.6-terra`. Set via `runtime.model` (`MONO_AGENT_MODEL`). See [Backends](/runtime/backends/).

## OpenInference

The semantic-convention vocabulary mono-agent uses when exporting traces (`openinference.span.kind` AGENT/LLM/TOOL/CHAIN, `input.value`/`output.value`, `openinference.project.name`). It is what makes Phoenix render runs as a semantic timeline. See [Phoenix and backfill](/observability/phoenix-and-backfill/).

## Provider session

A continuous, per-conversation session against the backend, kept warm and evicted after idle time so follow-up turns resume without re-sending full history. Configured via `runtime.session.mode` and `runtime.session.idleTimeoutMs` (`MONO_AGENT_SESSION_MODE`, `MONO_AGENT_SESSION_IDLE_TIMEOUT_MS`); pi-native sessions can be persisted to JSONL via `providers.piNative.piSessionsRoot`. See [Sessions and concurrency](/runtime/sessions-concurrency/).

## Rapid-log

The deterministic single-line host observation written after a completed turn. Lite/Journal store it in the canonical daily log (Journal hash-deduplicates and embeds in the background); BuJo stores it in a separate raw audit outside recall, before optional bounded curation. Controlled by `memory.writeMode` (`MONO_AGENT_MEMORY_WRITE_MODE`). See [Capture and recall](/memory/capture-and-recall/).

## Responder

The top-level entry point that takes an inbound request and produces a reply, delegating to the harness for execution. It is what channels and cron call (`responder.respond`), and what you build programmatically with `createConfiguredAgentResponder`. See [Composition](/programmatic/composition/).

## Consolidation

A scheduled, projection-only BuJo maintenance pass run by the in-app scheduler (no external cron needed): it refreshes `index.md`, keeps the retired `future-log.md` stub empty, and reports exact-normalized duplicate groups. It never decays static canonical salience or automatically supersedes, deletes, or rewrites canonical memories. Tune it via `memory.consolidation.*`; the default cron is `0 */2 * * *`. See [Consolidation](/memory/rituals/).

## RRF

Reciprocal Rank Fusion — the method the journal and BuJo tiers use to combine BM25 keyword results with vector results into one hybrid recall ranking (`memory.mode: "journal"` and above; requires an embeddings provider). See [Capture and recall](/memory/capture-and-recall/).

## Runtime bridge

The backend-specific glue (e.g. the pi-native bridge) that translates harness operations into a provider's API: it drives compaction, applies retry/session behavior, and emits the `provider_bridge_latency` event separating provider/tool/IO time from harness overhead. See [Backends](/runtime/backends/).

## Salience

Static `0..1` importance metadata stored with canonical journal and BuJo memories. Recall uses salience only as a small tie-breaker after RRF and evidence strength; age, last access, and access counts do not decay or otherwise alter it. See [Capture and recall](/memory/capture-and-recall/).

## srt

The sandbox runtime that wraps executed commands when `sandbox.mode: "native"` is set. On macOS, `mono-agent sandbox setup` installs the pinned runtime into a private user cache; `sandbox check` proves real enforcement. Missing or corrupt SRT follows `sandbox.fallback` (default [fail-closed](#fail-closed)); a corrupt managed install never falls back to PATH.

```json
{
  "sandbox": { "mode": "native", "fallback": "fail-closed" }
}
```

Env: `MONO_AGENT_SANDBOX_MODE`, `MONO_AGENT_SANDBOX_FALLBACK`. See [Sandbox](/tools/sandbox/).

The native `srt` contract applies to Pi-owned mono-agent tools. Uniform route
safety rejects a route that cannot enforce those scopes. Explicit
per-route-native routing may use Claude/Codex/OpenCode only under their recorded
provider-native contracts; SRT never pretends to cover those attempts.

## Trace source

The label/id identifying where a run originated (which channel or cron job), used to name the destination project on export (`openinference.project.name` defaults to the trace source). See [Artifacts and traces](/observability/artifacts-and-traces/).

## Related references

- [Feature matrix](/reference/feature-matrix/) — every capability and its coverage type
- [Config blueprint](/config/blueprint/) — annotated `mono-agent.config.json`
- [Environment variables](/config/env-vars/) — every `MONO_AGENT_*` override

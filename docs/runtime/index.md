---
title: "Runtime & Providers"
description: "Understand runtime selection, provider configuration, sessions, tools, and safety controls."
sidebar:
  order: 0
---

The runtime layer is what actually drives a model: which backend executes a turn, how reasoning effort and tool permissions are set, how failures fall back to backup models, how local providers are wired in, how provider sessions and concurrency are bounded, and which built-in tools (and their auto-guards) ship out of the box. The config-first controls live under `runtime`, `providers`, and `concurrency` in `mono-agent.config.json`, with the documented `MONO_AGENT_*` environment overrides. Custom runtimes, interactive approval callbacks, direct live-input queues, and orchestration remain programmatic surfaces; managed Slack, Telegram, and web-console turns supply their own live-input queue automatically.

## At a glance

A minimal runtime block selects a backend model and (optionally) backup models:

```json
{
  "runtime": {
    "model": "pi:openai-codex:gpt-5.6-terra",
    "fallbacks": [
      { "model": "pi:opencode-go:kimi-k2.6", "effort": "medium" },
      { "model": "pi:ollama:gemma4:31b" }
    ],
    "routeSafety": "uniform",
    "executionMode": "sdk",
    "effort": "medium",
    "permissionMode": "default",
    "maxTurns": 0,
    "session": { "mode": "continuous", "idleTimeoutMs": 1800000 }
  }
}
```

The `runtime.model` string is always `<backend>:<...>` — `pi:<provider>:<model>`, `claude:*`, `codex:*`, or `opencode:*`. Override it without touching config via `MONO_AGENT_MODEL`.

Guided init searches every bundled model for Pi Anthropic, GitHub Copilot, OpenAI Codex, and OpenCode-Go, plus Codex's live account catalog, the Claude SDK catalog, and discovered local models. Hand-authored Pi refs and `providers.local[]` remain compatible outside the guided cloud-provider set. A provider-declared live Codex default leads when available; curated direct Terra is the offline fallback. The offline entry does not fabricate effort metadata, so only provider-default effort is available until live discovery succeeds. GPT-5.6 Sol can be selected explicitly as `codex:gpt-5.6-sol` or `pi:openai-codex:gpt-5.6-sol`.

| Key | Env var | Default | Notes |
| --- | --- | --- | --- |
| `runtime.model` | `MONO_AGENT_MODEL` | `codex:gpt-5.6-terra` | Guided init can initially select the live Codex provider default; refs use `pi:<provider>:<model>`, `claude:…`, `codex:…`, or `opencode:…`. |
| `runtime.fallbacks` | `MONO_AGENT_FALLBACKS_JSON` | `[]` | ordered `{model, effort?}` routes; omitted effort = provider default |
| `runtime.routeSafety` | `MONO_AGENT_ROUTE_SAFETY` | `uniform` | `uniform` or `per-route-native` |
| `runtime.executionMode` | `MONO_AGENT_EXECUTION_MODE` | inferred from model | `sdk` or `cli` |
| `runtime.effort` | `MONO_AGENT_EFFORT` | provider/model default when unset | `none`/`minimal`/`low`/`medium`/`high`/`xhigh`/`max`/`ultra`; model support is narrower where advertised. Reasoning-capable `pi:*` maps `ultra` to LOW; Pi without reasoning uses OFF. Direct `codex:*` forwards `ultra` unchanged. Mono-agent rejects `ultra` on its Claude SDK route because the pinned SDK public contract ends at `max` (the SDK JavaScript itself forwards the value). The Claude CLI route passes `--effort ultra`, but both tested Claude Code binaries (SDK-bundled 2.1.206 and local 2.1.210) warn that it is unknown, ignore it, and use default effort. Direct OpenCode rejects explicit effort. Ranking above `max` only prevents keyword downgrade |
| `runtime.permissionMode` | `MONO_AGENT_PERMISSION_MODE` | `default` | CLI backends; `default`/`plan`/`acceptEdits`/`bypassPermissions` |
| `runtime.maxTurns` | `MONO_AGENT_MAX_TURNS` | `0` (unlimited) | `1`–`100` caps turns |
| `runtime.workspace` | `MONO_AGENT_WORKSPACE` | `.` | working dir for runtime tools |

## Child pages

- [Model backends](/runtime/backends/) — the five bridges (Claude SDK, Claude CLI, Codex app-server, Pi SDK with 15+ providers, OpenCode app-server), the `<backend>:<model>` syntax, and `sdk` vs `cli` execution modes.
- [Execution effort & permissions](/runtime/execution-effort-permissions/) — tune reasoning depth with `runtime.effort` and the tool-permission posture for CLI backends with `runtime.permissionMode`.
- [Fallback chains](/runtime/fallback/) — canonical `runtime.fallbacks`, exact route effort, mixed-provider safety contracts, legacy compatibility, and visible failover history.
- [Local providers](/runtime/local-providers/) — wire Ollama, LM Studio, or any OpenAI-compatible endpoint via `providers.local[]` for `pi:<provider>:<model>` references, plus pi-native transport tuning and Pi credential resolution.
- [Sessions & concurrency](/runtime/sessions-concurrency/) — continuous provider sessions with idle eviction (`runtime.session`) and per-channel admission/execution bounds (`concurrency.maxConcurrentRuns`, `concurrency.maxPendingRuns`).
- [Built-in tools & auto-guards](/runtime/tools-and-guards/) — the managed Read/Write/Edit/Glob/Grep/Bash/NodeRepl/WebFetch/WebSearch tools and the automatic guards (tool-output bloat truncation, WebFetch retry, cost tracking, context compaction).

## Local providers in one block

Point `pi:<provider>:<model>` at a self-hosted endpoint. The `id` becomes the `<provider>` segment, so the model below is referenced as `pi:ollama:gemma4:31b`:

```json
{
  "providers": {
    "local": [
      {
        "id": "ollama",
        "type": "ollama",
        "baseUrl": "http://localhost:11434",
        "enabled": true,
        "trustPublicUrl": false,
        "apiKeyEnv": "MY_PROVIDER_KEY",
        "models": [{ "name": "gemma4:31b", "capabilities": { "context_window": 32768 } }]
      }
    ]
  }
}
```

`type` is `ollama`, `lmstudio`, or `openai_compat`. Supply the key via `apiKeyEnv`: keep the secret value in `.env` and only its variable name in config. Inline `apiKey` remains schema-compatible for existing consumers, but ignored or untracked source config is not an exception to this placement convention. See [Local providers](/runtime/local-providers/) for the full provider/env reference and [Embeddings](/memory/embeddings/) for using the same providers in the memory tier.

## Sessions & concurrency

By default a conversation keeps a continuous provider session that is evicted after `idleTimeoutMs`; set `runtime.session.mode` to `per-message` for a fresh session each turn. Admission and execution are bounded **per channel**, so with N enabled channels the effective ceiling is N× the configured value:

```json
{
  "concurrency": {
    "maxConcurrentRuns": 4,
    "maxPendingRuns": 16
  }
}
```

`maxConcurrentRuns` (`MONO_AGENT_CONCURRENCY_MAX_CONCURRENT_RUNS`) caps how many runs hit the provider at once; `maxPendingRuns` (`MONO_AGENT_CONCURRENCY_MAX_PENDING_RUNS`) caps how many runs may be admitted before the provider step. Details and the session-store semantics are on [Sessions & concurrency](/runtime/sessions-concurrency/).

## Built-in tools & auto-guards

Mono-agent's managed tool surface includes Read/Write/Edit/Glob/Grep/Bash/NodeRepl/WebFetch/WebSearch, gated by [tool policy](/tools/policy/) (`tools.allowedTools` / `tools.disallowedTools`). Provider-owned routes enforce the representable native surface described in [Tool policy](/tools/policy/). Auto-guards run with no configuration: 256 KB tool-output truncation with best-effort separate artifact persistence to `artifacts.dir`, WebFetch in-tool retry on transient network errors, per-run cost/usage tracking, and bridge-driven context compaction. See [Built-in tools & auto-guards](/runtime/tools-and-guards/).

:::tip
Capabilities such as structured output (`runtimeOptions.outputSchema`), live in-flight input, human-in-the-loop approval gates, and tool parallelism are **code-only** — they are set through harness/runtime options, not config. See [Programmatic API](/programmatic/) and [Approval & structured output](/programmatic/approval-and-structured-output/).
:::

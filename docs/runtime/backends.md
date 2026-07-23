---
title: "Backends & model references"
description: "Choose among the five runtime bridges and use the canonical model-reference and execution-mode syntax."
sidebar:
  order: 1
---

This page documents every runtime backend mono-agent can route a turn to, the model-reference string that selects each one, and the execution mode and provider boundary involved. You pick a backend implicitly by setting one config key — `runtime.model` — to a model reference; the agent-runtime bridge registry resolves the reference (plus `runtime.executionMode`) to a concrete backend.

Coverage: **config**. Set the model reference in `runtime.model` (env `MONO_AGENT_MODEL`) and, when needed, `runtime.executionMode` (env `MONO_AGENT_EXECUTION_MODE`).

## Model reference grammar

A model reference is a `:`-delimited string. The leading segment is the runtime SDK id, which determines the backend family:

| SDK id | Reference shape | Example |
| --- | --- | --- |
| `claude` | `claude:<model>` | `claude:claude-sonnet-4-6` |
| `codex` | `codex:<model>` | `codex:gpt-5.6-terra` |
| `pi` | `pi:<provider>:<model>` | `pi:openai-codex:gpt-5.6-terra` |
| `opencode` | `opencode:<provider>:<model>` | `opencode:github-copilot:gpt-4.1` |

The four first-party runtime modules are `runtime-claude`, `runtime-pi`,
`runtime-codex`, and `runtime-opencode`. Each module owns deterministic model
validation while Core routes through an explicit runtime instance and model.
Legacy aliases are not module ids; use the exact syntax accepted by the
selected runtime definition.

For `pi:` and `opencode:` only the **first** colon separates provider from model, so model ids may contain slashes (e.g. `opencode:openrouter:anthropic/claude-3.5-sonnet`).

## Backends

| Backend | Reference format | Execution mode | Provider boundary | Example |
| --- | --- | --- | --- | --- |
| Claude SDK | `claude:<model>` | `sdk` | `@anthropic-ai/claude-agent-sdk` | `claude:claude-sonnet-4-6` |
| Claude Code CLI | `claude:<model>` | `cli` | `claude` CLI binary (resumes via `--resume`) | `claude:claude-sonnet-4-6` |
| Codex CLI | `codex:<model>` | `cli` (only) | Codex app-server subprocess | `codex:gpt-5.6-terra` |
| Pi SDK | `pi:<provider>:<model>` | `sdk` (only) | Pi SDK provider gateway (15+ providers) | `pi:github-copilot:gpt-4.1` |
| OpenCode | `opencode:<provider>:<model>` | `cli` (only) | `@opencode-ai/sdk` against OpenCode `auth.json` (75+ providers) | `opencode:github-copilot:gpt-4.1` |

### Claude (SDK and CLI)

`claude:<model>` references run under either execution mode. With `executionMode: "sdk"` (the default for `claude:`) the turn goes through the pinned Anthropic `@anthropic-ai/claude-agent-sdk` 0.3.206 bridge. Its model catalog is discovered in an isolated, authentication-independent process and preserves exact provider ids. With `executionMode: "cli"` it runs through the local `claude` CLI binary, which supports session resume across turns.

```json
{
  "runtime": {
    "model": "claude:claude-sonnet-4-6",
    "executionMode": "sdk"
  }
}
```

### Codex CLI

`codex:<model>` is CLI-only. The bridge keeps the Codex app-server subprocess and thread alive across turns when session keep-alive is set. Setting `executionMode: "sdk"` for a `codex:` model is rejected with "Codex CLI requires CLI execution mode."

```json
{
  "runtime": {
    "model": "codex:gpt-5.6-terra",
    "executionMode": "cli"
  }
}
```

The default execution mode for a `codex:` model is already `cli`, so `executionMode` can be omitted.

The init wizard runs bounded `codex --version`, `codex login status`, and app-server `model/list` discovery. Catalog availability, a detected login, and a route verified by a live no-tool turn are distinct states. The provider-declared live default leads when available; curated Terra is the offline fallback. The offline entry carries no guessed supported-effort/default-effort metadata and therefore offers only **Provider default** until live discovery succeeds. Missing installation or sign-in remains visible and recoverable; mono-agent never auto-installs Codex. Browser login uses `codex login`; headless/remote setup uses `codex login --device-auth` (`mono-agent auth login codex --codex-auth device`).

GPT-5.6 Sol is available through `codex:gpt-5.6-sol` or the separate Pi route `pi:openai-codex:gpt-5.6-sol`. Guided readiness makes one exact no-tool call per selected primary/fallback route before it can produce an **Agent ready** result.

The Codex app-server does not currently project arbitrary mono-agent allow/deny lists. Normal direct `codex:*` runs therefore require exact allow-all (`tools.allowedTools: ["*"]` and no `disallowedTools`, or the equivalent omitted allowlist); restrictive policies fail validation rather than being silently widened. The guided readiness probe is a separate internal contract: read-only sandbox, approval policy `never`, no MCP/dynamic tools, disposable session, and failure on the first command/file/MCP/tool event.

The wizard also presents `pi:openai-codex:gpt-5.6-terra` and `pi:openai-codex:gpt-5.6-sol` as selectable Pi candidates; they use a separate SDK/auth boundary, and a missing Pi auth store can be repaired with `mono-agent auth login openai-codex`.

### Pi SDK

`pi:<provider>:<model>` is SDK-only and is the broadest backend — the Pi SDK fronts 15+ providers, including `openai`, `openai-codex`, `anthropic`, `github-copilot`, `opencode-go`, `openrouter`, `ollama`, and `lmstudio`. Subscription/account-backed providers are reachable here, including OpenAI-Codex, Anthropic, GitHub Copilot, and OpenCode-Go. Self-hosted and local providers used via `pi:<provider>:<model>` are declared under `providers.local[]` — see [Local providers](/runtime/local-providers/).

```json
{
  "runtime": {
    "model": "pi:github-copilot:gpt-4.1",
    "executionMode": "sdk"
  },
  "providers": {
    "piAuthPath": "~/.pi/agent/auth.json"
  }
}
```

A `pi:` provider that only runs under SDK mode (which is all of them) is rejected under `cli`. For `pi:openai-codex:*` the error suggests `codex:<model>` for the Codex CLI path.

### OpenCode

`opencode:<provider>:<model>` is a real backend, CLI-only, bridged through `@opencode-ai/sdk` talking to an OpenCode server. Provider and model ids come from OpenCode's own registry (its `auth.json`), spanning 75+ providers including Copilot and ChatGPT. Setting `executionMode: "sdk"` for an `opencode:` model is rejected with "OpenCode CLI requires CLI execution mode."

```json
{
  "runtime": {
    "model": "opencode:github-copilot:gpt-4.1",
    "executionMode": "cli"
  }
}
```

Copilot-class models are therefore reachable two ways: through `pi:github-copilot:<model>` (SDK) and through `opencode:github-copilot:<model>` (CLI). OpenCode-Go models are also reachable through `pi:opencode-go:<model>` with API-key credentials stored in the Pi auth store. Pick the backend whose execution mode and auth source you want.

The init wizard's OpenCode discovery uses `opencode models opencode-go --pure` inside disposable private XDG state, accepts only `opencode-go/` entries, and references those discovered models as `pi:opencode-go:<model>` so setup can save `OPENCODE_API_KEY` into the Pi auth store and run OpenCode-Go through the Pi SDK path. Guided primary/fallback/repair selection rejects direct OpenCode rather than making an unprovable readiness claim. Flagged/non-TTY scaffolds and hand-authored `opencode:<provider>:<model>` config remain supported. Validation reads the exact provider id from the standard OpenCode `auth.json` without invoking auth middleware; live validation additionally runs a bounded, minimal-environment `opencode --version` check.

Direct OpenCode is deliberately tool-free. The runtime launches
`opencode run --format json --pure --agent mono-agent-runtime` with a
highest-precedence inline configuration that denies every permission, removes
native tool definitions, and disables external plugins. Any observed
`tool_use` event is a fatal protocol violation: the process is terminated, no
later text or session state is accepted, and the runtime drains.

The bridge requires stable OpenCode CLI >=1.15.0. It can reuse an opaque
OpenCode session on the same route, but it does not expose Core tools, MCP,
attachments, approvals, structured output, sandboxing, or live input. Core
therefore skips it whenever a request requires one of those capabilities.
Provider credentials still come from the explicitly allowed OpenCode
environment/auth boundary.

OpenCode is selected through an installed
[`@mono-agent/runtime-opencode`](../../packages/runtime-opencode/README.md)
module instance. Its module definition validates the route before the runtime
process is created.

## Execution modes

`runtime.executionMode` is `sdk` or `cli`. When omitted, mono-agent infers a default from the model reference (e.g. `claude:` → `sdk`, `codex:` → `cli`). Each backend constrains which modes are valid; incompatible combinations are rejected with a specific reason rather than silently coerced. See [Execution, effort & permissions](/runtime/execution-effort-permissions/) for `effort` and `permissionMode`.

| SDK id | Allowed execution mode(s) |
| --- | --- |
| `claude` | `sdk` or `cli` |
| `pi` | `sdk` only |
| `codex` | `cli` only |
| `opencode` | `cli` only |

## How routing actually works

The strict agent configuration and each selected runtime definition serve
different purposes and are kept in parity.

- **Routing:** [`@mono-agent/core`](../../packages/core/README.md) resolves the
  ordered `{ runtime, model }` route list against installed runtime instances.
- **Runtime support metadata:** each runtime package exposes its own pure model
  validator and reports the capabilities of the exact selected route.

:::caution
When adding a backend, update and test both surfaces. A registry-only bridge can
execute only when callers already provide the exact mode, while missing adapter
metadata breaks inference and validation before the turn reaches that registry.
:::

## Fallback chains

`runtime.fallbacks` takes an ordered, uncapped list of `{ model, effort? }` routes tried on retryable provider/auth failures. Omitted effort means the route's provider default. `runtime.routeSafety` controls mixed-family safety: `uniform` (default) requires one compatible monotonic contract; explicit `per-route-native` isolates each provider and records its route-local safety contract. Pi keeps mono-agent tool policy and records the configured guarantee: `disabled` for no sandbox policy, `mono-agent-srt` for fail-closed SRT, or `mono-agent-srt-unsafe-host-fallback` when policy prefers SRT but explicitly permits unsandboxed host execution if the engine is unavailable. This telemetry does not claim which branch ran. Claude and Codex use only controls they can represent; OpenCode is eligible only for tool-free, sandbox-off requests and enforces deny-all native permissions. Unsupported capabilities skip a route rather than being silently removed. Any fallback chain disables cross-turn provider-session reuse and relies on history/snapshot replay.

```json
{
  "runtime": {
    "model": "claude:claude-sonnet-5",
    "effort": "high",
    "fallbacks": [
      { "model": "codex:gpt-5.6-sol", "effort": "xhigh" },
      { "model": "pi:ollama:gemma4:31b" }
    ],
    "routeSafety": "per-route-native"
  }
}
```

Env: `MONO_AGENT_FALLBACKS_JSON`. CLI: repeat `--fallback <ref>` and optionally follow each with `--fallback-effort <provider-default|level>`. Legacy `runtime.fallbackModels` and `MONO_AGENT_FALLBACK_MODELS` remain supported with no removal deadline; the legacy CLI `--fallback-models` flag was removed. See [Fallback & failover](/runtime/fallback/) for router behavior and the failover report.

## Related

- [Local providers](/runtime/local-providers/) — declaring Ollama / LM Studio / OpenAI-compatible providers for `pi:<provider>:<model>`.
- [Execution, effort & permissions](/runtime/execution-effort-permissions/) — `executionMode`, `effort`, `permissionMode`.
- [Fallback & failover](/runtime/fallback/) — ordered backup models.
- [Sessions & concurrency](/runtime/sessions-concurrency/) — continuous vs per-message sessions and resume.
- [Environment variables](/config/env-vars/) — `MONO_AGENT_MODEL`, `MONO_AGENT_EXECUTION_MODE`, and friends.

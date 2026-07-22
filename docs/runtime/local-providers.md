---
title: "Local & self-hosted providers"
description: "Connect Ollama, LM Studio, and OpenAI-compatible private endpoints through Pi model references."
sidebar:
  order: 4
---

This page covers running mono-agent against local and self-hosted model servers — Ollama, LM Studio, and any OpenAI-compatible gateway — through the Pi backend, plus the credential path used for built-in Pi providers. You configure them under `providers` and reference each model as `pi:<id>:<model>` from `runtime.model` or canonical `runtime.fallbacks` (legacy `fallbackModels` still loads).

For an end-to-end walkthrough, see the playbook [Local-only Ollama agent](/playbooks/local-only-ollama-agent/).

## How local providers map to model refs

Each entry in `providers.local[]` defines a provider with an `id`. The Pi backend reaches its models with the ref form `pi:<id>:<model>`. For example, a provider with `id: "ollama"` exposing model `gemma4:31b` is referenced as `pi:ollama:gemma4:31b`.

This is the same `pi:<provider>:<model>` form used by built-in Pi providers (e.g. `pi:openai:gpt-5.5`); local providers simply add new ids you control. See [Backends & model refs](/runtime/backends/) for the full ref taxonomy.

Coverage: `config` — `providers.local[]` (`MONO_AGENT_LOCAL_PROVIDERS_JSON`, or the `MONO_AGENT_LOCAL_PROVIDER_*` single-provider env vars).

`mono-agent init` can discover local models while you scaffold: `ollama list` contributes `pi:ollama:<model>` choices, and LM Studio's default local server (`http://localhost:1234/v1/models`) contributes `pi:lmstudio:<model>` choices. Discovery is best-effort and bounded; missing CLIs or stopped servers show status in the wizard without failing the scaffold. Choosing a `pi:ollama:*` or `pi:lmstudio:*` primary or fallback model auto-adds the matching local provider module to the generated config, and `--auth` / interactive provider setup runs a reachability preflight instead of collecting secrets.

## The provider entry shape

| Key | Type | Notes |
| --- | --- | --- |
| `id` | string | Provider id used in `pi:<id>:<model>` refs. |
| `type` | `ollama` \| `lmstudio` \| `openai_compat` | Wire protocol of the server. |
| `baseUrl` | string | Server URL, e.g. `http://localhost:11434`. |
| `enabled` | boolean | Set `false` to keep the entry without loading it. |
| `trustPublicUrl` | boolean | Default `false`. Non-private (public) URLs are blocked unless this is `true`. |
| `apiKey` \| `apiKeyEnv` | string | `apiKeyEnv` names the environment variable holding the key and is the source-config convention. Inline `apiKey` remains schema-compatible for existing consumers, but keep secret values out of config. |
| `models[]` | array | Each `{ name, capabilities: { context_window } }`. |

```json
{
  "runtime": {
    "model": "pi:openai-codex:gpt-5.6-terra",
    "fallbacks": [{ "model": "pi:ollama:gemma4:31b" }]
  },
  "providers": {
    "local": [
      {
        "id": "ollama",
        "type": "ollama",
        "baseUrl": "http://localhost:11434",
        "enabled": true,
        "trustPublicUrl": false,
        "models": [
          { "name": "gemma4:31b", "capabilities": { "context_window": 32768 } }
        ]
      }
    ]
  }
}
```

The `capabilities.context_window` you declare tells the runtime how large the model's window is — it drives compaction and budgeting. Set it to the real window of the model you pulled; an inaccurate value leads to premature or missed compaction.

## Ollama (primary path)

Ollama is the recommended local path. Pull the model first, then reference it. A standard local Ollama install listening on `localhost:11434` needs no API key.

```bash
ollama pull gemma4:31b
```

```json
{
  "providers": {
    "local": [
      {
        "id": "ollama",
        "type": "ollama",
        "baseUrl": "http://localhost:11434",
        "enabled": true,
        "models": [
          { "name": "gemma4:31b", "capabilities": { "context_window": 32768 } }
        ]
      }
    ]
  }
}
```

The model `name` must match the exact tag you pulled (including any `:tag` suffix). If a ref resolves to a model Ollama has not pulled, the call fails — run `mono-agent validate` to surface reachability and model checks before starting. See the [`validate` CLI reference](/observability/cli-reference/#validate).

Ollama and LM Studio can power memory embeddings independently of the chat runtime; BuJo capture has its own explicit LLM configuration. Those settings live under `memory.embeddings` / `memory.llm`, not `providers.local`. See [Embeddings](/memory/embeddings/).

## LM Studio and OpenAI-compatible gateways

LM Studio and any OpenAI-compatible server (vLLM, Together, a self-hosted proxy, etc.) use the same entry shape with `type: "lmstudio"` or `type: "openai_compat"`. Point `baseUrl` at the server and supply a key via `apiKeyEnv` when the gateway requires one: keep the secret value in `.env` and only its variable name in config. Inline `apiKey` remains schema-compatible for existing consumers, but ignored or untracked source config is not an exception to this placement convention. If `apiKeyEnv` is declared but does not resolve to a non-empty value, `mono-agent validate` reports the route as `waiting`; omitting both key fields is treated as an intentional keyless provider.

```json
{
  "providers": {
    "local": [
      {
        "id": "studio",
        "type": "lmstudio",
        "baseUrl": "http://localhost:1234",
        "enabled": true,
        "models": [
          { "name": "qwen3.6-32b", "capabilities": { "context_window": 32768 } }
        ]
      },
      {
        "id": "gateway",
        "type": "openai_compat",
        "baseUrl": "https://llm.example.com",
        "enabled": true,
        "trustPublicUrl": true,
        "apiKeyEnv": "MY_GATEWAY_KEY",
        "models": [
          { "name": "llama-3.3-70b", "capabilities": { "context_window": 131072 } }
        ]
      }
    ]
  }
}
```

Set the key in the environment (a `.env` in the agent folder is loaded automatically):

```bash
MY_GATEWAY_KEY=sk-...
```

These ids are then referenced as `pi:studio:qwen3.6-32b` and `pi:gateway:llama-3.3-70b`.

### Public URL safety

mono-agent blocks non-private `baseUrl` values by default. To use a public/remote endpoint you must explicitly opt in with `trustPublicUrl: true`, and the URL must be HTTPS. This prevents an agent from silently exfiltrating prompts to an unintended host.

:::caution
Only set `trustPublicUrl: true` for gateways you control or trust. Private addresses (`localhost`, `127.0.0.1`, LAN ranges) are allowed without it; anything else is rejected until you trust it explicitly.
:::

## Setting providers via environment

The whole array can be supplied as JSON, which overrides the config file:

```bash
MONO_AGENT_LOCAL_PROVIDERS_JSON='[{"id":"ollama","type":"ollama","baseUrl":"http://localhost:11434","enabled":true,"models":[{"name":"gemma4:31b","capabilities":{"context_window":32768}}]}]'
```

For a single provider there are scalar equivalents: `MONO_AGENT_LOCAL_PROVIDER_ID`, `MONO_AGENT_LOCAL_PROVIDER_TYPE`, `MONO_AGENT_LOCAL_PROVIDER_BASE_URL`, `MONO_AGENT_LOCAL_PROVIDER_ENABLED`, `MONO_AGENT_LOCAL_PROVIDER_TRUST_PUBLIC_URL`, and `MONO_AGENT_LOCAL_PROVIDER_API_KEY`. See [Environment variables](/config/env-vars/) for precedence rules.

## Pi credentials (built-in providers)

Built-in Pi providers use the Pi auth file configured by `providers.piAuthPath` (default `~/.pi/agent/auth.json`) rather than `providers.local[]`. Some providers, such as `pi:openai-codex`, authenticate through OAuth/account flows; others, such as `pi:opencode-go`, use API-key credentials stored in the same auth file.

```json
{
  "providers": {
    "piAuthPath": "~/.pi/agent/auth.json"
  }
}
```

Override the path with `MONO_AGENT_PI_AUTH_PATH`. The single path precedence used by discovery, setup, `auth login`, readiness, validation, and runtime is `--pi-auth-path` (auth command only) → non-empty `MONO_AGENT_PI_AUTH_PATH` → non-empty `providers.piAuthPath` → `~/.pi/agent/auth.json`. A leading `~` expands to the current user's home; relative values resolve from the agent/invocation working directory. A malformed or unreadable config is an error; only a missing config falls through. This is separate from `providers.local[]`: built-in Pi providers are registered by the Pi backend, while `local[]` registers your own servers.

Run `mono-agent auth login <provider>` for the supported built-in Pi targets: Anthropic, GitHub Copilot, and OpenAI Codex use their bundled OAuth flows; OpenCode-Go uses `OPENCODE_API_KEY`. Anthropic accepts either its localhost callback or a final redirect URL pasted at the live terminal prompt; Pi validates the pasted code and OAuth state before token exchange. Standalone OpenCode-Go login collects the key through a masked TTY prompt. For an explicitly headless flow, pipe exactly one line with `--api-key-stdin`, for example `printf '%s\n' "$OPENCODE_API_KEY" | mono-agent auth login opencode-go --api-key-stdin`; without that flag mono-agent never copies the ambient key implicitly. Its key can be stored in the same owner-only auth file or left in the durable provider environment, and the wizard never copies an ambient key into `auth.json` unless secure-store persistence was selected explicitly. Other Pi provider refs remain compatible as hand-authored runtime configuration but do not gain an implied guided login flow.

mono-agent invokes its app-owned terminal wrapper around the bundled Pi OAuth provider against a private staged `auth.json`; it never trusts process exit alone. Before promotion it requires a JSON-object store, a valid credential for the requested provider, and unchanged sibling-provider data. Promotion runs under a durable identity-bound owner-only lock and installs a `0600` file with exclusive-link no-clobber semantics on supported POSIX systems. If that lock already exists, mono-agent removes it only when the secure record is identity-stable and `kill(pid, 0)` proves the process is gone with `ESRCH`; active, `EPERM`, malformed, or racing locks remain untouched. The canonical credential parent must be owned by the current user and not group/world-writable, while existing, staged, and recovery credential inodes must be current-user-owned, not group/world-writable, and have exactly the expected link count. Automatic Pi credential persistence refuses Windows and auth paths inside Git worktrees.

The interactive `mono-agent init` wizard keeps every bundled model for its supported Pi integrations—Anthropic, GitHub Copilot, OpenAI Codex, and OpenCode-Go—searchable even when authentication is missing, alongside discovered Ollama/LM Studio models. Hand-authored Pi refs and `providers.local[]` remain valid runtime configuration without becoming implied guided integrations. The wizard reports `catalog available`, `credential detected`, and `verified by live readiness` separately; an auth-store entry skips redundant login but does not claim the model works. On repair, the chosen upstream OAuth or OpenCode-Go API-key flow reruns and the exact route is checked again. `mono-agent validate` remains read-only and never runs login or writes keys.

Coverage: `config` — `providers.piAuthPath` (`MONO_AGENT_PI_AUTH_PATH`).

## Using a local model as a fallback

Local providers compose with the rest of the runtime. A common pattern is a hosted primary model with a local fallback so the agent stays available offline or when a quota is hit:

```json
{
  "runtime": {
    "model": "pi:openai-codex:gpt-5.6-terra",
    "fallbacks": [{ "model": "pi:ollama:gemma4:31b" }]
  }
}
```

Failover is reported in run results, never silent. See [Fallback chains](/runtime/fallback/) for ordering and behavior.

## Related

- [Backends & model refs](/runtime/backends/) — the `pi:<provider>:<model>` ref taxonomy.
- [Fallback chains](/runtime/fallback/) — composing local models into canonical `fallbacks`.
- [Embeddings](/memory/embeddings/) — Ollama, LM Studio, or OpenAI for semantic memory recall.
- [Local-only Ollama agent](/playbooks/local-only-ollama-agent/) — full walkthrough.

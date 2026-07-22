---
title: "Configuration"
description: "Learn how mono-agent loads configuration, applies environment overrides, activates features, and validates an agent."
sidebar:
  order: 0
---

A mono-agent is declared by `mono-agent.config.json` in its agent folder. Start here for the loading rules and top-level structure. Use the [annotated blueprint](/config/blueprint/) for a broad example and the [generated config reference](/config/reference/) for the complete field list.

## The one config file

The file brings the agent's model routes, context, channels, memory, tools, sandbox, and observability together. In normal CLI use, relative paths resolve from the agent folder. Programmatic callers choose that base with `cwd`.

Scaffold a new agent with the CLI:

```bash
mono-agent init --model codex:gpt-5.6-terra
```

A minimal valid config has exactly two fields:

```json
{
  "runtime": { "model": "codex:gpt-5.6-terra" },
  "context": { "identityPath": "./IDENTITY.md" }
}
```

`runtime.model` selects the backend (`claude:*`, `codex:*`, `pi:<provider>:<model>`, or `opencode:*`). `context.identityPath` points at the identity markdown. All other fields are optional, but omission does not always mean disabled: the loopback `tui` operator endpoint defaults on, and the interaction bridge can auto-start when its tools are available.

## How configuration is loaded

For a field that has an environment mapping, precedence is:

1. **Passed process environment** — the documented `MONO_AGENT_*` variable wins.
2. **`mono-agent.config.json`** — the declared value.
3. **Built-in default** — used when neither of the above is set.

Config fields may be JSON-only. Only fields with a documented `MONO_AGENT_*` mapping accept an environment override; the generated reference shows `--` when no mapping exists. For example, `runtime.model` maps to `MONO_AGENT_MODEL`, while `slack.shortcuts` is JSON-only.

The CLI prepares the environment before it invokes the config loader. It loads `./.env` without replacing variables already exported by the shell, then applies the precedence above. Use `--env-file <path>` to choose another dotenv file. The programmatic `loadMonoAgentConfigWithSources` function does **not** read dotenv files; callers must prepare and pass `env` themselves.

For example, these variables override both JSON values:

```json
{ "runtime": { "model": "codex:gpt-5.6-terra", "effort": "medium" } }
```

```bash
# Overrides both fields above without editing the file
export MONO_AGENT_MODEL="pi:opencode-go:kimi-k2.6"
export MONO_AGENT_EFFORT="high"
```

See [Environment variables](/config/env-vars/) for the full mapping and CLI loading details.

:::note
The CLI does not watch the file. Run `mono-agent restart` after an edit. An embedded host can instead call `app.applyConfigChange(reason)` explicitly; see [Programmatic composition](/programmatic/).
:::

## Sections at a glance

Each top-level key maps to one capability area. All are optional except the two required fields noted above.

| Section | Purpose | Page |
| --- | --- | --- |
| `agent` | Public display name; never used for paths, service ids, sessions, or provider identity | [Identity & Soul](/context/identity-and-soul/) |
| `runtime` | Model, execution mode, effort, sessions, concurrency | [Runtime](/runtime/) |
| `concurrency` | Per-channel admission and provider-execution bounds | [Sessions and concurrency](/runtime/sessions-concurrency/) |
| `providers` | Local/self-hosted providers, Pi credentials, pi-native tuning | [Local Providers](/runtime/local-providers/) |
| `context` | Identity, soul, selected skills | [Context Assembly](/context/assembly/) |
| `memory` | Tiered memory (lite/journal/bujo), embeddings, consolidation | [Capture & Recall](/memory/capture-and-recall/) |
| `tools` | Allow-all-by-default, runtime-enforced allow/deny policy; MCP servers | [Tool Policy](/tools/policy/), [MCP](/tools/mcp/) |
| `continuations`, `interaction` | Durable asynchronous results, ask-the-user, and progress bridges | [Durable continuations](/tools/durable-continuations/), [Delivery and send tools](/channels/delivery-and-send-tools/) |
| `sandbox` | Filesystem/network sandboxing for runtime commands | [Sandbox](/tools/sandbox/) |
| `artifacts`, `traceability`, `observability` | JSONL run artifacts, trace registry, Phoenix exporter | [Observability](/observability/) |
| `telegram`, `slack` | Built-in chat channels (opt-in via `enabled`) | [Channels](/channels/) |
| `webhook`, `openaiApi`, `cron` | Built-in HTTP, OpenAI-compatible, and scheduled channels | [Channels](/channels/) |
| `tui` | Default-on loopback operator endpoint | [Operator stream endpoint](/channels/tui/) |
| `channels.plugins[]` | External channel packages such as WhatsApp and A2A | [Write your own channel adapter](/programmatic/custom-channels/) |

Channels start independently. For most channels, omission or `enabled: false` reports `disabled`; the default-on `tui` endpoint reports `disabled` only when explicitly opted out. An enabled channel that lacks required settings reports `waiting_for_config`. A self-recovering transport can temporarily report `degraded` without stopping healthy channels.

## How sections activate

Activation depends on the surface:

- **Core behavior is configured by its block.** `memory`, `sandbox`, `concurrency`, and `observability` take effect when configured. Some supporting blocks, such as `providers`, only matter when another selection uses them.
- **Most external channels are opt-in.** `telegram`, `slack`, `webhook`, and `openaiApi` require `enabled: true`. Cron runs only enabled jobs. Plugin channels require a `channels.plugins[]` entry and follow the plugin's own config contract.
- **The operator endpoint is opt-out.** `tui` defaults to enabled on loopback; set its `enabled` field to `false` to remove it.
- **Host bridges have their own gates.** `continuations` uses its `enabled` flag. Interaction may auto-start from allowed ask tools, explicit interaction settings, or configured progress delivery.

If a channel section seems ignored, check `enabled` first — `mono-agent validate` reports it as `disabled` rather than `waiting`.

## Coverage types

The [Feature Registry](/reference/feature-registry/) tags each capability so you know how to reach it:

| Type | Meaning |
| --- | --- |
| `config` | Declarable in `mono-agent.config.json`; an env override exists only when documented |
| `cli` | Reached through a `mono-agent` CLI flag/command |
| `auto` | Always active when the app runs; needs no declaration |
| `code` | Programmatic escape hatch only — intentional |
| `dev` | Development/test tooling, not part of a running agent |

:::tip
A handful of capabilities are `code`-only — for example structured output
schemas, tool approval gates, and custom runtimes/channels. Direct runtime live
input is also a code API, while the managed Slack, Telegram, and web-console
hosts expose it automatically on capable backends. See [Programmatic
Composition](/programmatic/) and [Live input steering](/programmatic/approval-and-structured-output/#live-input-steering).
:::

## Validate before you run

`mono-agent validate` reports the resolved runtime, provider credentials, context, memory, tools, sandbox, observability, secret placement, and channel state. Exit code 0 means the config is structurally valid; a `waiting` section still needs attention and is not an **Agent ready** result. Static validation does not make a model request. See [CLI reference → validate](/observability/cli-reference/#validate) for the liveness and guided-init distinctions.

```bash
mono-agent validate
mono-agent start     # traceability + every configured channel
```

On `start`, each channel prints its initial state: `running`, `waiting_for_config`, `disabled`, or `failed`. A running transport that later enters self-recovery can report `degraded` until it recovers.

:::note
The **secret placement** section is advisory and non-fatal: it surfaces a `waiting` warning when a secret-marked field is resolved from the committed `mono-agent.config.json` instead of `.env`, naming the `MONO_AGENT_*` variable to move it to. It covers core secrets (e.g. `memory.embeddings.apiKey`) and every channel credential (`telegram.botToken`, `slack.botToken`/`slack.appToken`, `openaiApi.apiKey`, the A2A plugin bearer tokens). The secret value is never printed, and the warning never blocks `start`. The same warnings are also emitted by `mono-agent config`, which additionally shows every channel section field-by-field with the same `[env]`/`[json]`/`[default]` provenance as the core sections. See [Environment Variables](/config/env-vars/) for the variable map.
:::

## Related pages

- [Blueprint](/config/blueprint/) — a broad annotated `mono-agent.config.json` example.
- [Generated Config Reference](/config/reference/) — the generated key table and JSON Schema URL.
- [Environment Variables](/config/env-vars/) — the complete `MONO_AGENT_*` map.
- [Folder Layout](/config/folder-layout/) — files and directories around the config.
- [Feature Matrix](/reference/feature-matrix/) — canonical capability → config key reference.

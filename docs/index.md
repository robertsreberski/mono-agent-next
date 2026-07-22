---
title: "Home"
description: "Build and operate a config-first agent across channels, runtimes, tools, memory, and observability."
sidebar:
  order: 0
---

**mono-agent** is a config-first agent framework: one `mono-agent.config.json` turns any folder into a running agent, served at once over Webhook, an OpenAI-compatible API, Telegram, Slack, WhatsApp, A2A, and cron. It is published as `@mono-agent/*` packages on npm and driven by the `mono-agent` CLI — point a model at a workspace, flip on the channels you want, and `mono-agent start`.

:::note
New here? Read [Getting Started → Quickstart](/getting-started/quickstart/) to go from an empty folder to a live agent in a few commands.
:::

## What you get

- **Any backend, one model string** — `runtime.model` defaults to `codex:gpt-5.6-terra` and can select claude (sdk/cli), codex (cli), pi (sdk, 15+ providers), or opencode (cli); e.g. `codex:gpt-5.6-terra`, `codex:gpt-5.6-sol`, `pi:openai-codex:gpt-5.6-sol`, and `pi:opencode-go:kimi-k2.6`.
- **Many channels, one config** — external transports are opt-in, the loopback TUI operator endpoint is opt-out, and every active surface uses the same configured runtime, tools, memory, and context through its own responder/harness.
- **Batteries included** — managed Read/Write/Edit/Glob/Grep/Bash/NodeRepl/WebFetch/WebSearch tools, a tool policy, MCP servers, a native sandbox, tiered memory, and observability.

```json
{
  "runtime": { "model": "codex:gpt-5.6-terra" },
  "context": { "identityPath": "./IDENTITY.md" },
  "telegram": { "enabled": true },
  "openaiApi": { "enabled": true }
}
```

Equivalent env overrides: `MONO_AGENT_MODEL=codex:gpt-5.6-terra` and, for the enabled Telegram channel, `MONO_AGENT_TELEGRAM_BOT_TOKEN=...` in `.env`. Source configs omit credentials; see [Environment variables](/config/env-vars/) for the full mapping.

## Site map

- **[Getting Started](/getting-started/)** — install the CLI, scaffold a config, and run your first agent.
- **[Config](/config/)** — the `mono-agent.config.json` blueprint, env-var precedence, and folder layout.
- **[Runtime](/runtime/)** — model backends, fallback chains, local providers, effort/permissions, sessions, concurrency, and tool guards.
- **[Channels](/channels/)** — Telegram, Slack, WhatsApp, Webhook, OpenAI-compatible API, A2A, cron, and proactive delivery.
- **[Memory](/memory/)** — tiered capture/recall, embeddings, consolidation, the entity graph, and validation/CLI.
- **[Context](/context/)** — identity/soul, skills, and how the system prompt is assembled per turn.
- **[Tools](/tools/)** — the tool policy (allow/deny), MCP integration, and the native sandbox.
- **[Observability & operator consoles](/observability/)** — JSONL artifacts and traces, Phoenix/OTLP export and backfill, the CLI, TUI, and always-on web console.
- **[Programmatic](/programmatic/)** — the `code`-only escape hatches: composition, approval gates, structured output, multi-agent, A2A consumers, and custom channels.
- **[Playbooks](/playbooks/)** — end-to-end recipes (Telegram BuJo assistant, Slack MCP bot, local-only Ollama, sandboxed code agent, and more).
- **[Packages](/reference/packages/)** — every published package, its ownership tier, responsibility, npm page, and authoritative README.
- **[Reference](/reference/)** — the feature matrix, glossary, compatibility decisions, and setup-security contracts.

## Config-first philosophy

Everything that defines a running agent lives in `mono-agent.config.json`, resolved with a strict precedence for fields that expose an environment mapping: **process env > `mono-agent.config.json` > built-in defaults**. Documented `MONO_AGENT_*` overrides let one source config run in different environments without embedding credentials; JSON-only fields remain in the config file.

External channels and optional subsystems are generally **opt-in**: a transport is dormant until you enable it, while the loopback TUI endpoint defaults on and can be disabled explicitly. Security-sensitive surfaces (sandbox fallback, network policy, send-tool allowlists) **fail closed** by default. Approval gates, structured output, custom runtimes/channels, and direct runtime live input are programmatic escape hatches; managed Slack, Telegram, and web-console turns provide live follow-up steering automatically on capable backends. See [Programmatic](/programmatic/).

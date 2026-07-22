---
title: "Core Concepts"
description: "Understand mono-agent's config-first model, runtime boundaries, channels, tools, context, and optional services."
sidebar:
  order: 3
---

This page defines the mental model behind mono-agent: one config file, one agent definition, per-channel responders, and explicit runtime boundaries. The config tool surface defaults open; sandboxing and channel allowlists are the separate controls that constrain side effects, and guided init reconfirms allow-all when no sandbox is selected. Read it once and the rest of the docs will line up.

## Config-first

A mono-agent is fully described by a single `mono-agent.config.json` in the agent folder. The CLI does not watch that file: you (or an agent) edit the JSON, then run `mono-agent restart` to load the new config. An embedded app can instead call `app.applyConfigChange(reason)` explicitly to rebuild the current services and reconfigure its already-resolved drivers from the edited config; adding or removing a plugin package still requires a process restart.

```json
{
  "runtime": {
    "model": "codex:gpt-5.6-terra"
  },
  "context": {
    "identityPath": "./IDENTITY.md"
  }
}
```

```bash
mono-agent restart          # apply config edits
mono-agent restart --clear-sessions  # apply AND clear provider sessions + active chat history (durable memory kept)
```

Because the config is plain JSON, agents can edit their own config and restart themselves. Most capabilities are coverage type **config** — set a key, then restart the CLI host or explicitly re-apply an embedded app. A few are **cli** (run a command), **auto** (default behavior), **code** (only available programmatically — see [Programmatic](/programmatic/)), or **dev** (test-time tooling).

The full annotated config lives in [Configuration → Blueprint](/config/blueprint/), and folder conventions in [Folder Layout](/config/folder-layout/).

## One agent definition, per-channel responders

Each active channel gets its own configured responder and runtime harness — the components that turn an incoming prompt into a reply using the configured model, tools, context, and memory. Those responders are built from the same resolved agent config and share app-owned resources such as the configured memory store, but each harness has its own admission, session, and lifecycle boundary. Channels feed prompts into their own responder and deliver its output:

| Channel | Section | Transport |
| --- | --- | --- |
| Telegram | `telegram` | long-polling bot |
| Slack | `slack` | Socket Mode bot |
| WhatsApp | `channels.plugins[]` (`@mono-agent/whatsapp-adapter`) | Baileys socket (QR login) |
| Webhook | `webhook` | HTTP POST, sync/async |
| OpenAI API | `openaiApi` | OpenAI-compatible `/v1/chat/completions` |
| A2A | `channels.plugins[]` (`@mono-agent/a2a-adapter`) | Agent-to-Agent provider |
| Cron | `cron` | scheduled prompts |

Each channel is its own JSON section and runs independently — one failing or waiting on config never blocks the others. This per-channel harness boundary is also why configured concurrency limits apply per channel rather than globally. See [Channels](/channels/) for per-channel setup.

## Channel defaults and the five statuses

Communication channels are **off by default** and turn on with their `enabled` flag. The loopback `tui` operator endpoint and read-only `live` relay are deliberate exceptions: both default on with ephemeral ports and opt out with `enabled: false`. Put credentials such as `MONO_AGENT_TELEGRAM_BOT_TOKEN` in `.env`; the source-config example omits them:

```json
{
  "telegram": {
    "enabled": true,
    "allowedChatIds": ["123456789"]
  }
}
```

When you run `mono-agent start`, each channel prints exactly one status line:

| Status | Meaning |
| --- | --- |
| `disabled` | The resolved `enabled` value is false. For most channels omission resolves false; `tui` and `live` require an explicit false because they default on. |
| `waiting_for_config` | Enabled but a required setting is missing. The start line names the exact missing field. |
| `running` | Enabled and configured; the line shows its endpoint facts. |
| `degraded` | Was running, but the live transport hit a transient failure (e.g. the Telegram poller crashed on a network switch / `ENETUNREACH`). The channel owns its own recovery, so the responder/harness stays alive and keeps serving while the transport restarts; the line shows `degraded: <reason>` with a warning badge. It flips back to `running` once the restarted transport stays up. |
| `failed` | Enabled and configured but it could not start (or hit a fatal error); the line shows the reason. Unlike `degraded`, this is terminal — the responder is disposed and there is no auto-restart. |

An enabled-but-incomplete channel reports `waiting_for_config` rather than crashing the process — the rest of the agent keeps serving. A `degraded` channel is non-fatal too: it is still serving and self-recovering, distinct from a `failed` channel.

:::note
There is no "off but configured" trap: a channel with `enabled: false` reports `disabled` even if every other field is filled in.
:::

## Explicit side-effect boundaries

mono-agent ships with an open tool surface. Memory, channel admission, HTTP bind, and sandbox controls are separate; do not mistake one for another. Guided init names the shell/file/web/channel effects of allow-all and requires a second confirmation when no enforceable sandbox will constrain them. Native mono-agent SRT applies to Pi-owned tools. Uniform route safety rejects providers that cannot represent the common contract; explicit per-route-native routing displays and applies their provider-native contract instead.

- **Allow-all tools, runtime-specific narrowing.** Omit `tools.allowedTools` (or set `["*"]`) and the agent can call every built-in available on its route (the managed `Read`, `Write`, `Edit`, `Glob`, `Grep`, `Bash`, `NodeRepl`, `WebFetch`, `WebSearch` set on the Pi bridge) and every enabled channel's send tools. Pi and supported CLI runtimes can narrow their respective surfaces; direct `codex:*` normal runs accept exact allow-all only and reject restrictive policies instead of widening them.

  ```json
  {
    "tools": {
      "allowedTools": ["*"],
      "disallowedTools": []
    }
  }
  ```

  See [Tools → Policy](/tools/policy/).

- **No memory writes.** `memory.writeMode` defaults to `disabled` — the agent records nothing until you choose `append-host-summary` or (bujo only) `capture`. See [Memory → Capture and Recall](/memory/capture-and-recall/).

- **Loopback-only network.** HTTP channels (`webhook`, `openaiApi`, and the A2A plugin) bind to localhost and refuse non-loopback callers until you set `allowNonLoopback: true`. For Pi-owned tools, the native sandbox likewise starts with network `mode: "none"` and a deny-by-default filesystem (`.env*`, `.git/config`, `.git/hooks/**` are denied even when you widen the roots). See [Tools → Sandbox](/tools/sandbox/).

:::caution
Channels and tools also enforce their own destination allowlists (e.g. `telegram.allowedChatIds`, `slack.allowedChannelIds`). An empty allowlist with `allowAll*` left off means the agent will not act on anyone — that is the intended fail-closed behavior, not a bug.
:::

## Configuration precedence: env > JSON > defaults

Fields with a documented `MONO_AGENT_*` environment mapping use this resolution order; JSON-only fields stay in `mono-agent.config.json`:

1. **Process environment** (`MONO_AGENT_*`) — highest priority.
2. **`mono-agent.config.json`** — the JSON value.
3. **Built-in default** — used when neither is set.

So `MONO_AGENT_MODEL=pi:opencode-go:kimi-k2.6` overrides `runtime.model` in the JSON for that process. A `.env` file in the agent folder is loaded automatically (exported shell variables still win); use `--env-file <path>` for an alternate file.

| Config key | Env var |
| --- | --- |
| `runtime.model` | `MONO_AGENT_MODEL` |
| `tools.allowedTools` | `MONO_AGENT_ALLOWED_TOOLS` |
| `memory.writeMode` | `MONO_AGENT_MEMORY_WRITE_MODE` |
| `telegram.enabled` | `MONO_AGENT_TELEGRAM_*` |

The complete key → env mapping is in [Configuration → Env Vars](/config/env-vars/).

## Where to go next

- [Configuration](/config/) — the keys and their defaults.
- [Channels](/channels/) — turn on a transport.
- [Reference → Glossary](/reference/glossary/) — terms used across these docs.

---
title: "Channels"
description: "Compare the built-in and plugin channel adapters that receive turns and deliver mono-agent replies."
sidebar:
  order: 0
---

Channels are how a mono-agent receives input and delivers replies. Legacy channels on the transitional app plane retain their existing config sections. The v1 operator endpoint is an explicitly selected typed module under `channels.operator`; it is not a default-on `tui` section and it does not start either operator product. This page links the channel guides and records that migration boundary. Coverage: **config** unless a feature is noted otherwise.

## Core channels

| Channel | Transport | Section | Guide |
| --- | --- | --- | --- |
| Telegram | Bot long polling | `telegram` | [Telegram](/channels/telegram/) |
| Slack | Socket Mode bot | `slack` | [Slack](/channels/slack/) |
| Webhook | HTTP POST, sync or async | `webhook` | [Webhook](/channels/webhook/) |
| OpenAI-compatible API | `/v1/chat/completions` (SSE) | `openaiApi` | [OpenAI-compatible API](/channels/openai-api/) |
| Cron | Scheduled prompts | `cron` | [Cron](/channels/cron/) |
| Operator channel | Authenticated loopback HTTP/NDJSON turns for standalone products | `channels.operator` (`@mono-agent/channel-operator`) | [Operator channel](/channels/tui/) |

## External channel packages

| Channel | Transport | Plugin package | Guide |
| --- | --- | --- | --- |
| WhatsApp | Baileys socket (QR login) | `@mono-agent/whatsapp-adapter` | [WhatsApp](/channels/whatsapp/) |
| A2A | Agent-to-Agent provider/consumer | `@mono-agent/a2a-adapter` | [A2A](/channels/a2a/) |

Channels are fully independent: enabling one neither requires nor affects another, and a misconfigured channel never blocks the rest of the host from starting.

## Opt-in and the status lifecycle

Most legacy channels default to **off** and use their existing `enabled` field. The v1 [`operator` channel](/channels/tui/) is also absent until selected, but selection uses `$use: "@mono-agent/channel-operator"` plus mandatory environment-referenced bearer auth rather than an `enabled` toggle. It always binds loopback; there is no non-loopback override. Legacy status values below continue to describe the transitional host plane, while typed-module health is owned by Core and the selected module:

| State | Meaning |
| --- | --- |
| `disabled` | The resolved legacy `enabled` value is false. An unselected v1 typed module is absent rather than represented by a default-on compatibility channel. |
| `waiting_for_config` | `enabled: true` but a required setting is missing — the line names the exact missing field. |
| `running` | Ready and listening; the line includes endpoint facts (host/port/path, or the bot it connected as). |
| `degraded` | Was running but the live transport connection dropped on a transient failure (e.g. a Telegram poll crash on a network switch, or a Slack Socket Mode disconnect); the responder/harness is kept alive and the adapter is reconnecting, so the channel keeps serving. Rendered `degraded: <reason>` with a warning badge. Non-fatal and self-recovering — it returns to `running` automatically once the transport stays up, unlike `failed`. |
| `failed` | The channel errored on startup; the line includes the reason. |

```json
{
  "telegram": {
    "enabled": true,
    "allowedChatIds": ["123456789"]
  }
}
```

Put `MONO_AGENT_TELEGRAM_BOT_TOKEN=...` in the agent's `.env`; source-config examples omit credentials even though inline fields remain accepted for compatibility.

:::tip
Run `mono-agent validate` for a per-section report before starting, and `mono-agent status` to read the live state. Config is JSON-first. The CLI does not watch `mono-agent.config.json`, so run `mono-agent restart` after an edit. An embedded app can instead call `app.applyConfigChange(reason)` explicitly; adding or removing a plugin package still requires a restart because the driver set is resolved at startup.
:::

## Environment variables

Fields with a documented mapping can also be set with a `MONO_AGENT_<CHANNEL>_*` environment variable, which is especially useful for secrets you do not want in the JSON file. Some fields are JSON-only. A `.env` in the agent folder is loaded automatically (exported shell variables win); use `--env-file <path>` for an alternate file. Per-channel env var names are listed in each channel's guide. See [Environment variables](/config/env-vars/) for the complete mapping.

```bash
export MONO_AGENT_TELEGRAM_ENABLED=true
export MONO_AGENT_TELEGRAM_BOT_TOKEN=REPLACE_WITH_BOT_TOKEN
```

## Which channel?

Pick by who or what is on the other end:

| You want… | Use | Why |
| --- | --- | --- |
| A human chatting interactively | [Telegram](/channels/telegram/), [Slack](/channels/slack/), or [WhatsApp](/channels/whatsapp/) | Conversational adapters with allowlists, working indicators, and final-answer delivery; WhatsApp is loaded as an external plugin |
| Programmatic / pipeline invocation | [Webhook](/channels/webhook/) or [A2A](/channels/a2a/) | Webhook for plain HTTP POST (sync or async polling); A2A for agent-to-agent calls with Agent Card discovery and is loaded as an external plugin |
| A chat UI (e.g. Open WebUI) | [OpenAI-compatible API](/channels/openai-api/) | Exposes `/v1/models` + `/v1/chat/completions` with token-by-token SSE streaming |
| A first-party operator product | [Terminal operator](/observability/tui/) or [web operator](/observability/web-console/) | Connects through the explicitly selected authenticated loopback operator channel |
| Scheduled / unattended runs | [Cron](/channels/cron/) | Timezone-aware five-field jobs that invoke the responder on a schedule |

You can enable any combination — for example Telegram for your own use plus a webhook for automation and cron for a daily digest.

## Concurrency is per-channel

The app builds one runtime harness per channel, and each harness holds its own concurrency limiter. The `concurrency.*` bounds therefore apply to **each** channel independently, not as a single global cap: with N enabled channels the effective ceiling is N× the configured value. See [Sessions & concurrency](/runtime/sessions-concurrency/) for `maxConcurrentRuns` / `maxPendingRuns` and the admission model.

:::note
Conversational adapters (Slack/Telegram) do per-conversation admission and attachment downloads *before* the harness run boundary, so cross-conversation transport download IO is not covered by the harness concurrency bounds (per-file byte caps and timeouts apply instead). Adapter queues are drained/aborted on `/cancel` and stop.
:::

## Sending and proactive delivery

Replies go back over the same channel that received the request. To send *outbound* messages — proactive notifications from cron/webhook turns, or app-owned send tools like `SlackSendMessage` and `TelegramSendMessage` — see [Delivery & send tools](/channels/delivery-and-send-tools/). Note that these send tools require the target adapter to already be enabled and configured, and the adapter's own allowlist remains the delivery boundary.

## Custom transports

For a bespoke transport, implement a `ChannelDriver` from `@mono-agent/agent-contracts` and either expose it from a package loaded by `channels.plugins[]` or pass it via `startMonoAgentApp({ drivers })`. See [Write your own channel adapter](/programmatic/custom-channels/).

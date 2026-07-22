---
title: "WhatsApp"
description: "Connect a linked WhatsApp account, authorize chats, configure group triggers, and understand final-answer delivery."
sidebar:
  order: 3
---

The WhatsApp channel connects your agent to a personal WhatsApp account over a [Baileys](https://github.com/WhiskeySockets/Baileys) socket, authenticated by scanning a QR code at first start. It is provided by the external `@mono-agent/whatsapp-adapter` package and loaded through `channels.plugins[]`. The plugin config gates which chats can trigger the agent and lets you choose whether group messages require an @mention. Coverage: **config** — see [feature-registry](/reference/feature-matrix/) row `whatsapp.baileys`.

## Quick start

Declare the plugin package, enable the channel, and allow one or more chats:

```json
{
  "channels": {
    "plugins": [
      {
        "package": "@mono-agent/whatsapp-adapter",
        "id": "whatsapp",
        "config": {
          "enabled": true,
          "allowedChatJids": ["123@s.whatsapp.net"]
        }
      }
    ]
  }
}
```

On first `mono-agent start`, a QR code is printed to the start log. Open WhatsApp on your phone → **Linked devices** → **Link a device** → scan it. Baileys then writes its auth state to `.mono-agent/whatsapp-auth/` so subsequent starts reconnect without re-scanning.

:::caution
There is no bot token: WhatsApp links your own account as a paired device. Keep `.mono-agent/whatsapp-auth/` out of version control — it is your session, not a config value. See [folder layout](/config/folder-layout/).
:::

## Configuration

| Key | Type | Default | Purpose |
| --- | --- | --- | --- |
| `config.enabled` | boolean | `false` | Opt-in switch. Off means the channel reports "disabled" (not "waiting"). |
| `config.allowedChatJids` | string[] | `[]` | Allowlist of chat JIDs (e.g. `123@s.whatsapp.net` for a DM, `...@g.us` for a group) that may trigger the agent. |
| `config.allowAllChats` | boolean | `false` | When `true`, every chat is allowed; `allowedChatJids` is ignored. |
| `config.groupMode` | `"mention"` \| `"any"` | `"mention"` | Trigger rule for group messages (DMs always trigger — see below). |
| `config.botJids` | string[] | `[]` | Your linked account's JID(s), used to detect @mentions of the agent in groups. |
| `config.mentionTextAliases` | string[] | `[]` | Extra text aliases (e.g. `@agent`) that count as a mention even without a native WhatsApp mention. |
| `config.stripMentionText` | boolean | conditional | When `true`, the matched mention/alias text is removed from the message before it reaches the agent. When unset, defaults to `true` only when `mentionTextAliases` is non-empty; `botJids` alone does not enable stripping, so otherwise it defaults to `false`. |

Full annotated example:

```json
{
  "channels": {
    "plugins": [
      {
        "package": "@mono-agent/whatsapp-adapter",
        "id": "whatsapp",
        "config": {
          "enabled": true,
          "allowedChatJids": ["123@s.whatsapp.net", "987654321@g.us"],
          "allowAllChats": false,
          "groupMode": "mention",
          "botJids": ["456@s.whatsapp.net"],
          "mentionTextAliases": ["@agent"],
          "stripMentionText": true
        }
      }
    ]
  }
}
```

To allow every chat instead of an explicit allowlist, set `allowAllChats` and drop `allowedChatJids`:

```json
{
  "channels": {
    "plugins": [
      {
        "package": "@mono-agent/whatsapp-adapter",
        "id": "whatsapp",
        "config": { "enabled": true, "allowAllChats": true, "groupMode": "any" }
      }
    ]
  }
}
```

## When does the agent reply?

- **Direct messages** always trigger the agent (subject to the allowlist).
- **Group messages** trigger according to `groupMode`:
  - `mention` (default) — only when the message @mentions one of `botJids`, or contains one of `mentionTextAliases`.
  - `any` — every allowed group message triggers a run.

In both cases the chat must pass the allowlist: it must appear in `allowedChatJids`, or `allowAllChats` must be `true`. Authorization runs before commands and group-trigger evaluation. A chat that is not allowed receives the configured unauthorized response (`This WhatsApp chat is not authorized to use this bot.` by default); no agent turn starts.

The bundled event runner derives a queue from each usable, trimmed `remoteJid`; messages without one share a fallback queue. Within a queue it awaits both the message handler and its result callback before starting the next message. Different queues can enter the adapter concurrently, so one chat is not held behind another by the event runner, although configured runtime limits can still serialize the underlying agent turns. Completion and result-callback order across different chats is not guaranteed to match global receive order. A later message in the same chat, including `/cancel`, does not overtake the in-flight handler.

:::tip
`groupMode: "any"` in a busy group will run the agent on every message. Pair it with a tight `allowedChatJids` and consider [concurrency limits](/runtime/sessions-concurrency/) before enabling it.
:::

## Finding JIDs

A WhatsApp JID identifies a chat. DMs use the `<number>@s.whatsapp.net` form (digits only, no `+`); groups use `<id>@g.us`. The simplest way to discover them is to temporarily set `allowAllChats: true`, send a message, and read the resolved JID from the start log, then move it into `allowedChatJids` and disable `allowAllChats`. Put your own linked-account JID into `botJids` so group mention detection works.

## Environment variables

Every key has a `MONO_AGENT_*` override (precedence: env > JSON > defaults). See the full [environment variables](/config/env-vars/) reference.

| Env var | JSON key it overrides | Notes |
| --- | --- | --- |
| `MONO_AGENT_WHATSAPP_ENABLED` | plugin `config.enabled` | QR login; auth state in `.mono-agent/whatsapp-auth`. |
| `MONO_AGENT_WHATSAPP_ALLOWED_CHAT_JIDS` | plugin `config.allowedChatJids` | Or set `allowAllChats`. |
| `MONO_AGENT_WHATSAPP_ALLOW_ALL_CHATS` | plugin `config.allowAllChats` | Allow every chat instead of requiring `allowedChatJids`; default `false`. |
| `MONO_AGENT_WHATSAPP_GROUP_MODE` | plugin `config.groupMode` | `mention` / `any`. |
| `MONO_AGENT_WHATSAPP_BOT_JIDS` | plugin `config.botJids` | Comma-separated linked-account JIDs used to recognize native group mentions. |
| `MONO_AGENT_WHATSAPP_MENTION_TEXT_ALIASES` | plugin `config.mentionTextAliases` | Comma-separated text aliases that count as group mentions. |
| `MONO_AGENT_WHATSAPP_STRIP_MENTION_TEXT` | plugin `config.stripMentionText` | Remove the matched mention or alias before the prompt. When unset, defaults to `true` only when `mentionTextAliases` is non-empty. |

```bash
MONO_AGENT_WHATSAPP_ENABLED=true
MONO_AGENT_WHATSAPP_ALLOWED_CHAT_JIDS=123@s.whatsapp.net
MONO_AGENT_WHATSAPP_GROUP_MODE=mention
```

## Delivery behavior

WhatsApp buffers answer `append`/`replace` events in memory and sends only the **final answer** when the run finishes, split into bounded messages when needed. It may send one initial status such as `Thinking…`; reasoning, tool progress, and partial answer text are never streamed into chat. What the agent is permitted to do inside a run is governed by [tool policy](/tools/policy/).

The chat allowlist is the adapter's invocation boundary; the paired-device files are its account-login boundary. Protect `.mono-agent/whatsapp-auth/` as a secret: anyone who obtains a usable copy may be able to act as the linked WhatsApp device. The adapter does not encrypt or back up that directory.

WhatsApp has **no notify path of its own**. Native cron/webhook notification (`notify: true`) can target Telegram/Slack or explicit `web:new`, but WhatsApp is **not a notify-capable destination**. The agent can still be granted the `SlackSendMessage` / `TelegramSendMessage` send tools (if those adapters are enabled) to push messages back through Slack or Telegram, but there is no equivalent for pushing unprompted messages into a WhatsApp chat. See [delivery and send tools](/channels/delivery-and-send-tools/).

## Related

There is no WhatsApp-specific playbook yet. The closest end-to-end recipes are the [Telegram personal-assistant playbook](/playbooks/telegram-personal-assistant-bujo/) and the [Slack team-bot playbook](/playbooks/slack-team-bot-mcp-tools/); both translate directly — add an `@mono-agent/whatsapp-adapter` entry under `channels.plugins[]` and put the WhatsApp settings under that entry's `config`. See also the [Telegram](/channels/telegram/) and [Slack](/channels/slack/) channel pages for the shared mention/allowlist model, and the [Channels overview](/channels/).

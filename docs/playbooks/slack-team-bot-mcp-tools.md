---
title: "Slack Team Bot with MCP Tools"
description: "Configure an allowlisted Slack team bot with an external MCP tool server."
sidebar:
  order: 12
---

This playbook builds a shared Slack bot that answers when mentioned in allow-listed channels, calls a custom team MCP tool plus `Read`/`Grep`, and can post proactively with `SlackSendMessage`.

## Who this is for

A DevOps engineer running a shared team bot.

## Goal

A Slack Socket Mode bot, mention-triggered in allowed channels, with a custom MCP tool plus `Read`/`Grep` and the `SlackSendMessage` tool for proactive posts.

## Features used

- `slack.socket-mode` — [Slack channel](/channels/slack/)
- `runtime.per-trigger-model` — [Slack runtime controls](/channels/slack/#runtime-model-and-effort-controls-built-in)
- `channel.final-only-delivery` — [Delivery and send tools](/channels/delivery-and-send-tools/)
- `tool-policy.allowlist` — [Tool policy](/tools/policy/)
- `tool-policy.mcp-servers` — [MCP servers](/tools/mcp/)
- `agent-app.adapter-send-tools` — [Delivery and send tools](/channels/delivery-and-send-tools/)
- `runtime.concurrency` — [Sessions, concurrency & Pi-native tuning](/runtime/sessions-concurrency/)

## Configuration

The Slack section runs in Socket Mode (effective `botToken` and `appToken` values are required); Slack's `app_mention` event handles real mentions, the adapter discovers its own bot user ID/username, and the bot only responds in `allowedChannelIds`. Put `MONO_AGENT_SLACK_BOT_TOKEN` and `MONO_AGENT_SLACK_APP_TOKEN` in `.env`; the source config omits credentials. The built-in `@agent /model` / `@agent /effort` thread controls and workspace-registered `/<bot>-model` / `/<bot>-effort` channel controls automatically expose `runtime.model` plus any configured fallbacks, with no bot-ID or Slack-specific model config. This agent opts into a **specific** tool allowlist instead of the allow-all default, so the built-ins it uses and `SlackSendMessage` are named explicitly; `deployTool` comes from the declared MCP server. `concurrency` bounds in-flight work app-wide.

```json
{
  "runtime": {
    "model": "claude:claude-sonnet-4-6"
  },
  "slack": {
    "enabled": true,
    "allowedChannelIds": ["C012345"],
    "stripMentionText": true
  },
  "tools": {
    "allowedTools": ["Read", "Grep", "SlackSendMessage", "deployTool"],
    "mcpConfigPath": "./mcp.json"
  },
  "concurrency": {
    "maxConcurrentRuns": 4,
    "maxPendingRuns": 8
  }
}
```

Secrets can also come from the environment: `MONO_AGENT_SLACK_BOT_TOKEN` and `MONO_AGENT_SLACK_APP_TOKEN`.

:::caution
The exact MCP tool name (`deployTool` here) must match the name your server advertises. MCP-server tools are available because their server is **declared** in `mcp.json`, not because they appear in `tools.allowedTools` — see [MCP servers](/tools/mcp/).
:::

## Steps

1. Create a Slack app with Socket Mode (app token `connections:write`), a bot token (`chat:write` plus `commands` for slash controls), and **Interactivity & Shortcuts** enabled so runtime selectors can deliver `block_actions` over Socket Mode. Register `/<bot-username>-model` and `/<bot-username>-effort`; Socket Mode needs no Request URL.
2. `mono-agent init --model claude:claude-sonnet-4-6`
3. Write `mcp.json` with the team's stdio MCP server; `deployTool` becomes available from the server declaration (MCP tools aren't gated by `tools.allowedTools`). This playbook keeps a specific allowlist, so it lists `deployTool` for readability, but the entry is not what enables it.
4. Set a specific `tools.allowedTools` (the built-ins you want plus `SlackSendMessage`) and add the `slack` section; set concurrency bounds (note: per-channel scope). Or drop `tools.allowedTools` entirely to keep the allow-all default.
5. `mono-agent validate`, then `mono-agent start` (confirm Slack is running with both tokens).
6. Mention the bot in an allowed channel and confirm a 👀 reaction, then a final reply. If a tool runs, confirm the final reply is a new message and the temporary activity message is removed.

## Smoke test

:::tip
Mention `@agent` in the allowed channel; verify the seen reaction, a final answer, the MCP tool firing in the run artifact, and that `SlackSendMessage` can post to the allowed channel (and is rejected for a non-allowed one). Run `/<bot-username>-model`, choose an option, and verify turns in two threads inherit it. Then send `@agent /model` in one thread, choose another model, and verify only that thread overrides the channel selection. Confirm colon-delimited references stay literal in the menu.
:::

## Related

- [Slack channel](/channels/slack/)
- [Delivery and send tools](/channels/delivery-and-send-tools/)
- [Tool policy](/tools/policy/)
- [MCP servers](/tools/mcp/)
- [Sessions, concurrency & Pi-native tuning](/runtime/sessions-concurrency/)
- [Composer skill](https://github.com/robertsreberski/mono-agent/blob/main/packages/agent-app/skills/mono-agent-composer/SKILL.md)

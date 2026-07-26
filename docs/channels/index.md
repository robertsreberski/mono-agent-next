---
title: "Channels and triggers"
description: "Select one of the five channel modules explicitly, and keep scheduled work in the separate cron trigger."
sidebar:
  order: 0
---

Channels are typed agent modules. Every configured instance has a stable map
key and an exact `$use` package that must be a direct production dependency:

| Package | Boundary |
| --- | --- |
| `@mono-agent/channel-webhook` | Bounded authenticated HTTP ingress and explicit webhook delivery. |
| `@mono-agent/channel-openai-api` | Bounded authenticated OpenAI-compatible API for one agent. |
| `@mono-agent/channel-telegram` | Telegram Bot API polling, authorization, interaction, and delivery. |
| `@mono-agent/channel-slack` | Slack Socket Mode ingestion, interaction, and Web API delivery. |
| `@mono-agent/channel-operator` | Authenticated loopback protocol consumed by standalone TUI and web products. |

The [generated config reference](/config/reference/) shows the sanitized
minimal and Personal selections. The [package directory](/reference/packages/)
links to each channel's exact schema, behavior, public API, and focused tests.

`@mono-agent/trigger-cron` is not a channel. It reads Markdown jobs from the
configured directory and references stable runtime and proactive-channel
instance ids. Long prompts remain in `cron/*.md`, not duplicated in JSON.

Installing a package does not activate it. Core loads only literal `$use`
selections and does not scan dependencies, a catalog, or arbitrary paths.
WhatsApp and A2A are explicit cuts.

Core keeps structured tool activity separate from assistant-authored response
text. Telegram edits one bounded transient status message, Slack updates the
assistant-thread status (or retains its existing eyes-reaction fallback), and
webhook exposes the latest status only while an async request is running. These
projections include the tool name and completed/failed state, never tool input,
result content, or call ids; they are not durable conversation messages.

## Telegram lifecycle signals

The Telegram adapter registers `/model`, `/effort`, `/cancel`, and `/help` as
the bot's exact command menu each time a channel instance starts. A menu
registration failure is visible as degraded module health while message
polling continues.

`reactions.working` is temporary. Every control return and terminal turn either
replaces it with an enabled done/error reaction or clears it with Telegram's
empty reaction list. Disabling `reactions.done` therefore disables the thumbs-up
without leaving the working reaction behind.

`transport.ipFamily` is an optional IPv4/IPv6 pin and is not part of the
`personal` scaffold default. The selected dispatcher and fetch implementation
come from the same cohesive transport as its multipart constructor. Without a
pin, the adapter resolves the runtime fetch and `FormData` pair when the client
is created. Concurrent starts share one command-registration and polling
operation; stop or drain aborts registration and prevents a late poller.
Transient polling errors retry with bounded backoff; Bot API `401`, `403`, and
`409` responses stop polling after one failure and surface sanitized,
actionable unhealthy status instead of retrying a permanently dead channel.

The [operator channel guide](/channels/tui/) covers the endpoint shared by the
two standalone operator products.

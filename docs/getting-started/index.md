---
title: "Getting Started"
description: "Follow the path from installing mono-agent to creating, validating, and understanding your first agent."
sidebar:
  order: 0
---

This section takes you from an empty folder to a readiness-proven agent. Bare `mono-agent init` on a TTY names the agent, searches the provider catalogs, and runs a real no-tool check for every selected route before the strict full **Agent ready** gate; flag/non-TTY init creates a scaffold only. mono-agent remains config-first: one `mono-agent.config.json`, driven by the CLI.

## The path

1. **Install** — get the published CLI or build the source CLI.
2. **Quickstart** — run guided init, understand catalog/auth/route verification and the full-agent gate, then smoke-test the ready webhook agent.
3. **Concepts** — understand the moving parts so the rest of the docs make sense.

## Pages

| Page | What it covers |
| --- | --- |
| [Install](/getting-started/install/) | Install the `mono-agent` CLI, scaffold a new project with `mono-agent init`, and confirm your toolchain is ready. |
| [Quickstart](/getting-started/quickstart/) | Scaffold a minimal `mono-agent.config.json`, validate it, and run your first agent turn when model auth is available. |
| [Concepts](/getting-started/concepts/) | The core model — agent, runtime, channels, tools, memory, and context — and how config maps onto them. |

## Where to go next

Once your agent runs, branch out by topic:

- [Configuration](/config/) — the full annotated config blueprint, environment variables, and folder layout.
- [Runtime](/runtime/) — model backends, fallback chains, sessions, and execution effort.
- [Channels](/channels/) — connect Telegram, Slack, WhatsApp, webhooks, the OpenAI-compatible API, A2A, and cron.
- [Always-on web console](/observability/web-console/) — keep multiple browser conversations with auto-discovered local agents over a trusted LAN or tailnet.
- [Programmatic](/programmatic/) — for capabilities that are code-only rather than config-driven.

:::note
Every capability in mono-agent carries a coverage type — **config**, **cli**, **auto**, **code**, or **dev** — so you always know whether to reach for the config file, a CLI command, or the SDK. The [feature matrix](/reference/feature-matrix/) is the canonical map.
:::

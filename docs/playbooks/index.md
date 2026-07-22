---
title: "Playbooks"
description: "Choose an end-to-end recipe for common mono-agent channels, runtimes, memory, tools, and operations."
sidebar:
  order: 0
---

This section collects end-to-end recipes. Each one walks the same arc — **init → configure → validate → start → smoke** — using only real `mono-agent.config.json` keys and the `mono-agent` CLI, so you can copy a playbook, adapt the placeholders, and have a working agent in minutes.

Every recipe ends with a concrete smoke test (a Telegram message, a `curl`, a cron tick, a Phoenix span) so you can prove the agent works before you ship it.

## How to use these

1. Pick a recipe from the [selector](#pick-a-recipe) or the [full table](#all-recipes) below.
2. Run `mono-agent init` with the suggested `--model` (and `--memory` / repeated canonical `--fallback` routes where shown).
3. Edit `mono-agent.config.json` per the recipe — keys are cross-checked against [the config blueprint](/config/blueprint/) and [feature registry](/reference/feature-matrix/).
4. Run `mono-agent validate` (catches missing tokens, unreachable providers, un-pulled local models, consolidation cadence, and exporter reachability), then `mono-agent start`.
5. Run the recipe's smoke test and inspect the JSONL run artifact under `artifacts.dir`.

:::note
`mono-agent init`, `validate`, and `start` are **cli** coverage; most knobs below are **config**. Recipes that compose responders in TypeScript (multi-agent and some A2A) are **code**-only — see [Programmatic](/programmatic/).
:::

## Pick a recipe

Choose along three axes, in order: **channel** (how messages reach the agent), then **memory tier**, then **deployment shape**.

### 1. By channel

| You want the agent reachable via… | Start with |
| --- | --- |
| Telegram (long-polling) | [Personal Telegram Assistant](/playbooks/telegram-personal-assistant-bujo/) |
| Slack (Socket Mode, mention-triggered) | [Slack Team Bot](/playbooks/slack-team-bot-mcp-tools/) · [Cron Digest → Slack](/playbooks/cron-digest-proactive-notify/) |
| An OpenAI-compatible `/v1` endpoint (Open WebUI, SDKs) | [OpenAI Endpoint for Open WebUI](/playbooks/openai-endpoint-open-webui/) |
| Plain HTTP (sync + async jobs) | [Webhook Automation](/playbooks/webhook-automation-sync-async/) |
| Another agent over A2A | [A2A Provider + Consumer](/playbooks/a2a-provider-and-consumer/) |
| A scheduled prompt (no inbound channel) | [Cron Digest](/playbooks/cron-digest-proactive-notify/) |
| The local terminal TUI only | [Local-Only Ollama Agent](/playbooks/local-only-ollama-agent/) · [Local-Only LM Studio Agent](/playbooks/local-only-lmstudio-agent/) · [Phoenix-Observed Agent](/playbooks/phoenix-observed-agent/) |

See [Channels](/channels/) for the full per-channel reference.

### 2. By memory tier

| Memory need | Tier | Recipe |
| --- | --- | --- |
| Remember every turn, scheduled consolidation, semantic recall | `bujo` | [Telegram Assistant with BuJo](/playbooks/telegram-personal-assistant-bujo/) |
| Durable notes + semantic recall, no scheduled consolidation | `journal` | [Local-Only Ollama](/playbooks/local-only-ollama-agent/) · [Sandboxed Code Agent](/playbooks/sandboxed-code-agent/) · [Cron Digest](/playbooks/cron-digest-proactive-notify/) |
| Stateless / no long-term memory | — | [Webhook](/playbooks/webhook-automation-sync-async/) · [OpenAI Endpoint](/playbooks/openai-endpoint-open-webui/) · [A2A](/playbooks/a2a-provider-and-consumer/) |

Memory tiers, `writeMode`, embeddings, and consolidation are covered in [Memory](/memory/capture-and-recall/) and [Consolidation](/memory/rituals/).

### 3. By deployment shape

| Shape | Recipe |
| --- | --- |
| Single agent, one channel | most recipes above |
| Fully local / air-gapped (no cloud, no outbound network) | [Local-Only Ollama](/playbooks/local-only-ollama-agent/) · [Local-Only LM Studio](/playbooks/local-only-lmstudio-agent/) |
| Reliability-hardened (ordered model fallback) | [Multi-Model Fallback Chain](/playbooks/multi-model-fallback-chain/) |
| Composed / multi-agent (delegation) | [Multi-Agent Orchestration](/playbooks/multi-agent-orchestration/) · [A2A Pair](/playbooks/a2a-provider-and-consumer/) |
| Observed (tracing + dashboards) | [Phoenix-Observed Agent](/playbooks/phoenix-observed-agent/) · [Backfill Historical Runs](/playbooks/backfill-historical-runs/) |

## All recipes

| Recipe | Who it's for | Goal |
| --- | --- | --- |
| [Personal Telegram Assistant with BuJo Memory](/playbooks/telegram-personal-assistant-bujo/) | Individual power user wanting a private assistant that remembers | Telegram long-polling bot that captures every turn into BuJo memory, consolidates it automatically, and recalls past notes semantically. |
| [Personal Telegram Assistant with Supermemory](/playbooks/telegram-supermemory-memory/) | Power user trying an external memory layer while keeping the agent local | Telegram long-polling bot that captures every turn into a local Supermemory instance and recalls past memories through the same `MemoryRecall` tool. |
| [Slack Team Bot with MCP Tools](/playbooks/slack-team-bot-mcp-tools/) | DevOps engineer running a shared team bot | Slack Socket Mode bot, mention-triggered in allowed channels, with a custom MCP tool plus Read/Grep and `SlackSendMessage` for proactive posts. |
| [Fully Local Ollama Agent (No Cloud)](/playbooks/local-only-ollama-agent/) | Privacy-focused user with no cloud API budget | Agent running entirely on local Ollama via the Pi runtime, with journal memory on local embeddings and no outbound network. |
| [Fully Local LM Studio Agent (No Cloud)](/playbooks/local-only-lmstudio-agent/) | Privacy-focused user who prefers LM Studio's GUI over Ollama's CLI | Agent running entirely on a local LM Studio provider via the Pi runtime, with lite-tier FTS memory and no outbound network (optional journal-tier upgrade using LM Studio's own embeddings). |
| [OpenAI-Compatible Endpoint for Open WebUI](/playbooks/openai-endpoint-open-webui/) | AI infra engineer fronting the agent with a chat UI | Expose the agent as an OpenAI-compatible `/v1` endpoint so Open WebUI can stream responses and keep multi-turn state. |
| [Webhook Automation with Sync + Async Endpoints](/playbooks/webhook-automation-sync-async/) | Backend developer integrating the agent into a pipeline | Accept fast sync HTTP calls and long-running async jobs (202 + status polling) across multiple named endpoints, some defined as markdown. |
| [Cron Digest with Native Notify](/playbooks/cron-digest-proactive-notify/) | Data analyst wanting a scheduled briefing pushed to a chat | Timezone-aware cron job that builds a daily digest with shared history and delivers the final answer through native Telegram, Slack, or web-console notification. |
| [A2A Provider + Consumer Pair](/playbooks/a2a-provider-and-consumer/) | Platform integrator connecting two agents over A2A | Publish agent A as an A2A provider (Agent Card discovery, bearer) and configure agent B to discover and call it. |
| [Multi-Agent Orchestration (AskCollaborator)](/playbooks/multi-agent-orchestration/) | Workflow designer composing specialist agents | One orchestrator delegates subtasks to named collaborator responders via the loopback `AskCollaborator` MCP tool. |
| [Sandboxed Code Agent (Loopback Only, Deny .env)](/playbooks/sandboxed-code-agent/) | Security team deploying an internal code assistant | Agent that reads repos and runs Bash inside the native sandbox with loopback-only network access and protected secrets, recalling local context. |
| [Phoenix-Observed Agent with TUI](/playbooks/phoenix-observed-agent/) | Agent builder evaluating runs in a tracing dashboard | Run an agent with the TUI, attempt a best-effort terminal-batched Phoenix export, and retain a bounded local JSONL snapshot after terminal persistence; a pre-terminal crash can omit the Phoenix batch and terminal event snapshot. |
| [Backfill Historical Runs to Phoenix](/playbooks/backfill-historical-runs/) | Operations engineer onboarding observability after the fact | Retroactively export already-recorded JSONL run artifacts to Phoenix with original timestamps, idempotently. |
| [Multi-Model Fallback Chain with Transcript Resume](/playbooks/multi-model-fallback-chain/) | Reliability-minded builder who can't afford a single-provider outage | Primary cloud model with ordered backups the failover router tries on retryable failures, resuming from the transcript tail. |
| [Interactive Agent with Long Jobs & Large Media](/playbooks/interactive-transcription-large-media/) | Builder whose agent must ask before acting, run multi-minute tools, and exchange large files | Telegram agent that blocks on `AskUser` for context, streams progress from a long transcription tool (keep-alive past 120s), accepts recordings over 20 MB via a self-hosted Bot API server, and returns a generated document. |

:::tip
Always run `mono-agent validate` before `start`. It is the single fastest way to catch a missing `botToken`, an un-pulled Ollama model, an unreachable Phoenix endpoint, or a duplicate webhook path before they bite you at runtime.
:::

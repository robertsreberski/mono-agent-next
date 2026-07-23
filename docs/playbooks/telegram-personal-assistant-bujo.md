---
title: "Personal Telegram Assistant with BuJo Memory"
description: "Build a private Telegram assistant backed by file-based bullet-journal memory."
sidebar:
  order: 1
---

This playbook wires a private Telegram bot to mono-agent's BuJo tiered memory so it captures every conversation turn, consolidates the store automatically, and recalls past notes semantically. It is a complete config-first recipe: pull the local models, init, fill in the Telegram and memory sections, validate, and start.

## Who this is for

Individual power users who want a private assistant that remembers — a personal Telegram bot scoped to your own chat that builds up durable memory across days rather than starting fresh every conversation.

## Goal

A Telegram bot that answers via long-polling, captures every turn into BuJo memory with scheduled consolidation, and recalls past notes semantically.

## Features used

- [`telegram.long-polling`](/channels/telegram/) — Telegram channel via getUpdates long-polling (config)
- [`channel.final-only-delivery`](/channels/delivery-and-send-tools/) — Telegram delivers the final answer only, not intermediate tokens (auto)
- [`memory.bujo`](/memory/rituals/) — BuJo tier: capture + scheduled consolidation (config)
- [`memory.per-turn-capture`](/memory/capture-and-recall/) — `writeMode: "capture"` records each turn asynchronously (config)
- [`memory.bujo-consolidation`](/memory/rituals/) — in-app lightweight consolidation (config / auto)
- [`memory.recall-tool`](/memory/capture-and-recall/) — `MemoryRecall` defaults on for every configured memory tier (auto)
- [`memory.embeddings-config`](/memory/embeddings/) — embeddings provider for semantic recall (config)

## Configuration

The bujo tier requires both an embeddings provider (for semantic recall) and an app-level
`memory.llm` (for capture and effective tier selection for scheduled consolidation). Guided
init lets you choose Ollama or LM Studio for embeddings and keeps the capture LLM explicit:
generated configs use `agent-host`, while this older fully-local recipe deliberately keeps an
explicit Ollama `memory.llm`. Selecting LM Studio embeddings would not move capture to LM
Studio or create a cross-provider fallback.

Put `MONO_AGENT_TELEGRAM_BOT_TOKEN=...` in `.env`; the source config omits the credential.

```json
{
  "runtime": {
    "model": "claude:claude-sonnet-4-6"
  },
  "telegram": {
    "enabled": true,
    "allowedChatIds": ["123456789"]
  },
  "memory": {
    "mode": "bujo",
    "path": "./.mono-agent/memory",
    "writeMode": "capture",
    "embeddings": {
      "provider": "ollama",
      "model": "nomic-embed-text:v1.5",
      "endpoint": "http://localhost:11434",
      "dim": 768
    },
    "llm": {
      "provider": "ollama",
      "model": "qwen3.6:latest",
      "endpoint": "http://localhost:11434"
    },
    "consolidation": { "enabled": true, "cron": "0 */2 * * *" }
  }
}
```

Keep `botToken` out of the file by setting `MONO_AGENT_TELEGRAM_BOT_TOKEN` in
`.env` instead. The memory LLM provider/model/endpoint can also come from
`MONO_AGENT_MEMORY_LLM_PROVIDER`, `MONO_AGENT_MEMORY_LLM_MODEL`, and
`MONO_AGENT_MEMORY_LLM_ENDPOINT`.

:::note
Consolidation runs in-app on the schedule above — no external cron or launchd is needed.
:::

:::caution
Use the exact `nomic-embed-text:v1.5` tag; the bare `nomic-embed-text` tag resolves to a different model and breaks recall.
:::

## Steps

1. Pull the local models the memory tier needs: `ollama pull nomic-embed-text:v1.5 && ollama pull qwen3.6:latest`.
2. Scaffold the agent: `mono-agent init --model claude:claude-sonnet-4-6 --memory bujo`.
3. In guided init choose Ollama for this recipe's embeddings, put
   `MONO_AGENT_TELEGRAM_BOT_TOKEN` in `.env`, then edit
   `mono-agent.config.json`: add the `telegram` section with `allowedChatIds`,
   set `memory.writeMode` to `capture`, and keep the explicit Ollama `memory.llm`
   block shown above. To use LM Studio embeddings instead, choose it in the
   wizard and leave the capture LLM independently explicit.
4. Run `mono-agent validate` and confirm memory liveness — embeddings and chat model pulled, and the consolidation cadence shown.
5. Run `mono-agent start` and confirm telegram reports running.
6. Send a fact from an allowed chat (e.g. "My dog is named Pixel"), then in a later turn ask a paraphrased question and confirm recall.

## Smoke test

:::tip
From the allowed Telegram chat, send a message; verify the typing indicator then a final answer. Then ask about a previously stated fact and confirm `MemoryRecall` appears in the run JSONL artifact and the answer uses it.
:::

## Related

- [Telegram channel](/channels/telegram/)
- [Delivery and send tools](/channels/delivery-and-send-tools/)
- [Memory consolidation](/memory/rituals/)
- [Capture and recall](/memory/capture-and-recall/)
- [Embeddings](/memory/embeddings/)
- [Artifacts and traces](/observability/artifacts-and-traces/) — where the run JSONL lands
- [Quickstart](/getting-started/quickstart/) — build this agent from one config

---
title: "Personal Telegram Assistant with Supermemory"
description: "Build a private Telegram assistant with hosted Supermemory capture and recall."
sidebar:
  order: 2
---

This playbook wires a private Telegram bot to an **external [Supermemory](https://supermemory.ai) instance** instead of mono-agent's built-in BuJo engine. Supermemory does memory extraction and consolidation server-side, so you do not need a separate memory chat LLM or local embeddings — the agent just posts each turn and recalls relevant memories over REST.

It runs fully locally: Supermemory ships as a single OSS binary (`supermemory-server`, MIT) with an embedded graph engine and on-machine embeddings. The only external dependency is an OpenAI-compatible LLM endpoint for extraction, which a local Ollama satisfies.

## Who this is for

Power users who want to try a best-in-class external memory layer (or already run Supermemory) rather than the built-in BuJo engine, while keeping everything on their own machine. BuJo remains the default and is unchanged — this is an opt-in alternative backend selected by one config field.

## Goal

A Telegram bot that answers via long-polling, captures every turn into a local Supermemory instance, and recalls past memories semantically through the same `MemoryRecall` tool the agent already knows.

## Features used

- [`telegram.long-polling`](/channels/telegram/) — Telegram channel via getUpdates long-polling (config)
- [`memory.backend-supermemory`](/config/env-vars/) — `memory.backend: "supermemory"` selects the external engine (config)
- [`memory.per-turn-capture`](/memory/capture-and-recall/) — `writeMode: "capture"` posts each turn for server-side extraction (config)
- [`memory.recall-tool`](/memory/capture-and-recall/) — `MemoryRecall` proxies Supermemory search behind the same in-app tool name (auto)

## Prerequisites

1. **Install the optional mono-agent plugin at the exact app version:**

   ```bash
   APP_VERSION="$(mono-agent --version | sed 's/^mono-agent //')"
   npm install "@mono-agent/memory-supermemory@${APP_VERSION}"
   ```

2. **Install and run Supermemory** (one binary, no Docker):

   ```bash
   curl -fsSL https://supermemory.ai/install | bash
   # First boot runs a setup wizard (pick an LLM provider) and prints an API key (sm_...).
   # Fully local extraction via Ollama, for example:
   OPENAI_BASE_URL=http://localhost:11434/v1 OPENAI_API_KEY=ollama OPENAI_MODEL=gpt-oss:20b supermemory-server
   ```

   It serves on `http://127.0.0.1:6767` and **requires the bearer key it prints** — save it.

3. Pull the runtime model you reference (and Ollama, if you use it for both the agent and Supermemory's extractor).

## Configuration

Select the backend with `memory.backend` and point it at your instance. `mode` and `path` are bujo-only and ignored by the external backend, but the loader still requires them. The API key is read from the environment, never written into JSON.

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
    "backend": "supermemory",
    "writeMode": "capture",
    "supermemory": {
      "baseUrl": "http://127.0.0.1:6767",
      "container": "my-telegram-agent"
    },
    "recallTool": { "enabled": true }
  }
}
```

`.env` (secrets stay out of JSON):

```bash
MONO_AGENT_TELEGRAM_BOT_TOKEN=123456:ABC...
MONO_AGENT_MEMORY_SUPERMEMORY_API_KEY=sm_...
```

If you omit `supermemory.container`, it defaults to the agent's trace `sourceId` so all of one agent's memories share a namespace (Supermemory's value is cross-conversation consolidation).

## How it works

- **Capture** — `writeMode: "capture"` awaits admission of each completed turn to `POST /v3/documents` under a stable run-id-derived custom id before terminal reporting. A bounded 10,000-entry same-process LRU suppresses recent exact retries; retries outside that window repeat the same remote stable-id upsert rather than creating another logical document. Supermemory extracts and consolidates facts server-side, so no `memory.llm` is needed. Indexing remains asynchronous: a just-admitted turn is not instantly searchable (seconds to minutes). An admission failure emits a safe memory-degradation warning without replacing the already-successful provider answer.
- **Recall into context** — at the start of each turn the agent searches your container (`POST /v4/search`, falling back to the legacy `/v3/search` if your build doesn't serve v4) and primes the reply with the top hits. If Supermemory is unreachable the turn proceeds with no memory rather than failing.
- **The `MemoryRecall` tool** — the agent can also recall on demand; the tool proxies Supermemory search behind the same name it uses for BuJo, so prompts and skills don't change between backends.

## Validate and run

```bash
mono-agent validate
mono-agent start
```

`validate` fails with the exact matching plugin install command when the optional package is absent. Once the package and config are present it makes a bounded, read-only liveness probe against the exact configured base URL; it sends no API key or memory data. Any HTTP response proves transport reachability. A connection failure or timeout reports the memory section as non-fatal `waiting` with recovery guidance, so start `supermemory-server` or fix `memory.supermemory.baseUrl`, then re-run `mono-agent validate` before relying on capture and recall.

## Notes and limits

- **Self-host vs cloud.** The same config works against the hosted cloud (`baseUrl: "https://api.supermemory.ai"` + a cloud `sm_...` key). The OSS binary self-hosts for personal use; production enterprise-grade self-hosting is a separate arrangement.
- **MCP server.** Supermemory's hosted MCP server is cloud-only and cannot point at a self-hosted instance, so recall here uses the in-app REST-proxied tool (works everywhere). `memory.supermemory.exposeMcpServer: true` additionally injects the hosted MCP server for cloud deployments that have an API key.
- **No shared index with BuJo.** Switching backends does not migrate existing BuJo memories; the two stores never share data.
- **Consolidation.** BuJo's in-app consolidation scheduler does not run for external backends — Supermemory does its own server-side consolidation.

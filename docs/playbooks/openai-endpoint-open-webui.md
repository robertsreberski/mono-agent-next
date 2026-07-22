---
title: "OpenAI-Compatible Endpoint for Open WebUI"
description: "Expose mono-agent through its OpenAI-compatible API and connect an Open WebUI client."
sidebar:
  order: 4
---

This playbook exposes a mono-agent agent as an OpenAI-compatible `/v1` endpoint so [Open WebUI](https://github.com/open-webui/open-webui) (or any OpenAI client) can list the model, stream responses token-by-token over SSE, and keep multi-turn conversation state per chat.

## Who this is for

AI infra engineers fronting the agent with a chat UI.

## Goal

Expose the agent as an OpenAI-compatible `/v1` endpoint so Open WebUI can stream responses and keep multi-turn conversation state.

## Features used

- [`openai-api.chat-completions`](/channels/openai-api/) — `/v1/models` + `/v1/chat/completions` with SSE streaming and an optional bearer key.
- [`openai-api.session-headers`](/channels/openai-api/) — session continuity via the `X-OpenWebUI-Chat-Id` / `X-Conversation-Id` request headers (only the latest user turn is forwarded per conversation).
- [`runtime.provider-sessions`](/runtime/sessions-concurrency/) — continuous provider sessions that retain context across requests.

All three are `config` coverage — no code required.

## Configuration

```json
{
  "runtime": {
    "model": "claude:claude-sonnet-4-6",
    "session": {
      "mode": "continuous",
      "idleTimeoutMs": 1800000
    }
  },
  "openaiApi": {
    "enabled": true,
    "host": "0.0.0.0",
    "port": 4040,
    "basePath": "/v1",
    "allowNonLoopback": true,
    "modelId": "my-agent"
  }
}
```

:::caution
Binding to a non-loopback host (`0.0.0.0`) requires both `allowNonLoopback: true` and `MONO_AGENT_OPENAI_API_KEY` — validation and startup refuse the configuration if either guard is missing. Clients send the key as an `Authorization: Bearer ...` header.
:::

Create an owner-only `.env` in the invocation folder (`chmod 600 .env`) and add:

```dotenv
MONO_AGENT_OPENAI_API_KEY=<strong-client-bearer>
```

The same settings can be supplied via environment variables (`MONO_AGENT_*`); see [Environment variables](/config/env-vars/) for the full mapping.

## Steps

1. `mono-agent init --model claude:claude-sonnet-4-6`
2. Add the `openaiApi` section; set `allowNonLoopback: true` for a non-loopback bind, put `MONO_AGENT_OPENAI_API_KEY` in the owner-only `.env`, set `modelId`, and enable continuous session mode under `runtime.session`.
3. `mono-agent validate`, then `mono-agent start` and confirm the status line reports `openaiApi` `running` with its endpoint.
4. In Open WebUI, add an OpenAI connection pointing at `http://host:4040/v1` with the bearer key.
5. Send two consecutive messages in one Open WebUI chat and confirm continuity (only the latest user turn is forwarded per conversation; prior context comes from the continuous session keyed by the chat id header).
6. Verify SSE streaming token-by-token in the UI.

## Smoke test

:::tip
`curl /v1/models` returns `my-agent`; `curl /v1/chat/completions` with the `x-openwebui-chat-id` header twice and confirm the second call resumes the session (continuity) and streams via SSE.
:::

## Related

- [OpenAI-compatible API channel](/channels/openai-api/)
- [Sessions & concurrency](/runtime/sessions-concurrency/)
- [Runtime backends](/runtime/backends/)
- [Environment variables](/config/env-vars/)
- [mono-agent composer skill](https://github.com/robertsreberski/mono-agent/blob/main/packages/agent-app/skills/mono-agent-composer/SKILL.md)

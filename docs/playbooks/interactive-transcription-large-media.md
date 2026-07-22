---
title: "Interactive Agent with Long Jobs & Large Media"
description: "Combine long-running MCP work, durable continuations, and large-media delivery in an interactive agent."
sidebar:
  order: 15
---

This playbook shows the capabilities unlocked by two composable framework features and how they fit together in one agent:

1. **Blocking `AskUser`** — a tool the agent calls mid-turn with one to five structured questions and **waits** for the answers, which come back to the same run (so the agent keeps its full working context instead of ending the turn and re-orienting later).
2. **Long-running tools with live progress + keep-alive** — a tool call can run for minutes (transcription, rendering, a slow API), stream status to the chat, and never trip the runtime's inactivity timeout because tool progress resets it.
3. **Large inbound/outbound media** — a self-hosted Telegram Bot API server lifts the 20 MB bot-download limit to 2 GB, and `TelegramSendFile` delivers big files back by local `file://` path with no in-process buffering.

The worked example is a **transcription assistant**: send it a voice note or a long recording, it asks who is speaking and in what language, transcribes via a local WhisperKit server (minutes for a long file), and returns the transcript as a document.

:::note
`AskUser` and tool progress are powered by the app's **interaction bridge**. The bridge starts automatically when `AskUser` is allowed, when the `interaction` block or an interaction env override is configured, or when `interaction.progress.enabled` resolves true and `tools.mcpRequestContextServers` names at least one opted project MCP server. This playbook explicitly pins `127.0.0.1`; keep that loopback bind because the runtime does not reject non-loopback values. With the shown configuration, nothing is exposed off-host. See [Delivery and Send Tools](/channels/delivery-and-send-tools/) and [Telegram](/channels/telegram/).
:::

## Who this is for

Builders whose agent needs a real conversation mid-task (clarify before acting), whose tools take minutes rather than seconds, or who exchange audio/video/large files — not just short text. Any one of the three features is useful alone; this recipe shows them together.

## Goal

A Telegram agent that: asks the user for context before it acts (blocking), runs a multi-minute tool while posting progress, accepts recordings far larger than 20 MB, and returns a generated file — all loopback-only, nothing public.

## Features used

- **`AskUser`** — blocking, channel-agnostic structured questions with two or three described choices each, optional multi-select, and a custom-reply path; available under the allow-all default, or name it in a specific `tools.allowedTools` (this playbook uses a specific list). One consolidated call of up to five questions per conversation; graceful timeout. See [Delivery and Send Tools](/channels/delivery-and-send-tools/). *(config)*
- **`interaction`** — the app-owned bridge block (`bridge.port`, `askUser.timeoutMs`, `progress.enabled`); auto-starts for allowed `AskUser`, configured interaction JSON/env, or enabled progress for an opted `tools.mcpRequestContextServers` entry. See [Env Vars](/config/env-vars/). *(config)*
- **`tools.mcpCallTimeoutMs` / `tools.mcpCallMaxTotalTimeoutMs`** — inactivity timeout (reset by tool progress) and the hard per-call wall clock; raise the latter for long jobs. See [Env Vars](/config/env-vars/). *(config)*
- **tool progress → channel status** — an opted stdio MCP `POST`s with a run-scoped progress capability; the destination comes from trusted request context and the status appears in the producing chat. *(config + code in your MCP tool)*
- **`telegram.apiRoot` + `telegram.attachments`** — point the adapter at a self-hosted Bot API server and raise the download/upload caps (2 GB ceiling). See [Telegram → Self-hosted Bot API server](/channels/telegram/). *(config)*
- **`TelegramSendFile`** — deliver a generated file. Under the strict configuration below, the host binds the producing Telegram conversation automatically (the agent supplies no `chat_id`) and reads a `path` upload through a pinned descriptor. Non-strict self-hosted uploads can use the `file://` fast path. See [Delivery and Send Tools](/channels/delivery-and-send-tools/). *(config)*
- **`telegram.bot`** — inbound audio/voice is downloaded and handed to the agent as a saved file path; the adapter chat allowlist is the boundary. See [Telegram](/channels/telegram/). *(config)*

## Configure

`mono-agent.config.json` (the transcription agent, trimmed to the relevant keys):

```jsonc
{
  "runtime": {
    "model": "pi:openai-codex:gpt-5.6-sol",
    "executionMode": "sdk",
    "session": { "mode": "continuous", "idleTimeoutMs": 1800000 }
  },
  "context": { "identityPath": "./IDENTITY.md", "selectedSkills": [] },
  "tools": {
    "allowedTools": ["Read", "Bash", "AskUser", "TelegramSendMessage", "TelegramSendFile"],
    "mcpConfigPath": "./.mcp.json",
    "mcpRequestContextServers": ["transcribe"],
    "mcpCallTimeoutMs": 120000,        // inactivity cap; tool progress resets it
    "mcpCallMaxTotalTimeoutMs": 2700000 // hard per-call wall clock (45 min) for long jobs
  },
  "interaction": {
    "bridge": { "host": "127.0.0.1", "port": 4471 },
    "askUser": { "timeoutMs": 600000 }, // wait up to 10 min for the user's answer
    "progress": { "enabled": true }
  },
  "telegram": {
    "enabled": true,
    "allowedChatIds": ["<your-chat-id>"],
    "apiRoot": "http://127.0.0.1:8081",          // self-hosted Bot API server (see below)
    "attachments": { "maxBytes": 268435456, "maxUploadBytes": 268435456 }, // 256 MiB
    "sendTools": { "scope": "producing-conversation", "pathScope": "run-output" }
  }
}
```

`.mcp.json` wires the project-local long-running tool (here, a WhisperKit transcription client — any slow MCP tool works the same way):

```jsonc
{
  "mcpServers": {
    "transcribe": {
      "type": "stdio",
      "command": "node",
      "args": ["./tools/transcribe-mcp/dist/mcp-server.js"],
      "env": { "ARGMAX_BASE_URL": "http://localhost:50060" }
    }
  }
}
```

The self-hosted Bot API server (only needed for attachments over 20 MB) runs loopback-only; see the [Telegram self-hosted section](/channels/telegram/) for the `logOut`/build/launchd details.

## How the turn flows

1. A voice note or recording arrives. The adapter downloads it (up to `attachments.maxBytes`, via the self-hosted server for big files) and hands the agent the saved file path.
2. **Caption-first**: if the caption already gives language/speakers, the agent skips asking. Otherwise it calls **`AskUser`** once with related language and speaker questions and *blocks*. Telegram presents them sequentially with two or three proposed answers, **Other** for typed context, and **Done** if a question permits multiple selections. The agent continues in the same run after the final answer.
3. The agent calls the long-running `transcribe` tool. That tool `POST`s progress to the bridge ("Transcribing 12:31… 45s elapsed"), which shows as a status message edited in place, and emits MCP progress notifications that keep the call alive well past 120s.
4. The transcript is written to the current run-output directory and delivered via **`TelegramSendFile`** with `{ "kind": "document", "path": "…" }`. The model supplies no destination; the host binds the producing Telegram conversation, and strict mode reads the file through a pinned descriptor rather than the self-hosted `file://` fast path.

Writing the progress side of a long tool is a few lines. The host overlays these
values only for servers named by `tools.mcpRequestContextServers`:

```ts
// inside your MCP tool, while the long job runs
const url = process.env.MONO_AGENT_INTERACTION_PROGRESS_URL;
const token = process.env.MONO_AGENT_INTERACTION_PROGRESS_TOKEN;
if (url && token) {
  await fetch(new URL("/v1/progress", url), {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ key: "transcribe", message: "Transcribing… 45s", state: "working" }),
  });
}
```

## Validate & start

```bash
mono-agent validate --config ./mono-agent.config.json   # confirms AskUser is allowed, apiRoot parses, caps in range
mono-agent start --config ./mono-agent.config.json
```

`validate` shows `Tools & MCP` with `AskUser` allowed and the interaction bridge ready; the bridge starts on `start`.

## Smoke test

1. **Ask-and-wait**: send a voice note with **no caption**. Expect one AskUser interaction with the related questions shown sequentially. Tap proposed answers or use **Other** for a typed reply; after the final answer, the job begins. (Send a caption that already names the language/speakers and no questions should appear.)
2. **Long job + progress**: for a multi-minute recording, watch the status message update in place; the call must not die at 120s (proof the keep-alive works).
3. **Large media**: send a recording over 20 MB (needs the self-hosted server). It downloads and transcribes; a plain hosted bot would have skipped it.
4. **File delivery**: the transcript comes back as an attached `.md` document, not pasted into the chat.
5. **Timeout path**: leave the `AskUser` interaction incomplete past
   `askUser.timeoutMs` — the tool returns any answers already submitted, marks
   the remaining questions unanswered, and treats your later reply as a normal
   next turn.

## Notes & limits

- Inbound attachment bytes travel as base64 through the request, so keep `attachments.maxBytes` at or below ~256 MiB (peak transient memory ≈ 3.4× the file size). For files beyond that, send a local path in a message instead — the agent runs on the same host.
- One pending `AskUser` per physical conversation; the model must consolidate related decisions into one call of at most five questions. On an app restart a pending ask degrades to normal multi-turn (the reply arrives as the next message).
- `mcpCallMaxTotalTimeoutMs` is the unresettable ceiling (default 45 min); a job longer than that is cut off regardless of progress.
- Everything here is loopback-only: the interaction bridge binds `127.0.0.1`, and the self-hosted Bot API server must be started with `--http-ip-address=127.0.0.1`. Long polling means nothing inbound is exposed.

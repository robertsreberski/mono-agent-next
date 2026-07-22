---
title: "Operator stream endpoint"
description: "Configure the conversational NDJSON operator endpoint used by local mono-agent consoles."
sidebar:
  order: 9
---

This channel serves the loopback NDJSON stream used by the [`mono-agent tui`](/observability/tui/) and [always-on web console](/observability/web-console/). Unlike the [OpenAI-compatible API](/channels/openai-api/) (which flattens events into Chat Completions chunks), it preserves structured `AgentStreamEvent` kinds — thinking deltas, tool calls with arguments/progress/results/timing, token usage, cost, provider lifecycle and failover, warnings — subject to the serialized event-frame cap described below.

The configuration and registry id remains `tui` for compatibility, but human status output calls this shared endpoint **gui** and its default HTTP path is `/gui`. It does not mean the web service embeds or launches the terminal UI: `mono-agent tui` and `mono-agent web` are two independent clients of the same conversational operator endpoint.

Coverage: `config` (the `tui` section of `mono-agent.config.json`).

:::note
**This operator surface is ON by default.** It binds loopback with an ephemeral port and needs no credentials by default, so the TUI/web console can chat without a per-agent config edit. Set `"tui": { "enabled": false }` to opt out; everything else about the channel lifecycle (status lines, `degraded`/`failed` reporting) matches the other channels.
:::

## Configuration

```json
{
  "tui": {
    "enabled": true,
    "host": "127.0.0.1",
    "port": 0,
    "basePath": "/gui",
    "allowNonLoopback": false
  }
}
```

| Key | Type | Default | Purpose |
| --- | --- | --- | --- |
| `enabled` | boolean | **`true`** | Deliberate exception to the channels-off convention (see the note above). |
| `host` | string | `127.0.0.1` | Bind address. Loopback by default. |
| `port` | integer | `0` | `0` = ephemeral. The bound port is published to the trace-source registry, so nothing needs to be fixed. |
| `basePath` | string | `/gui` | Path prefix for all endpoints. |
| `allowNonLoopback` | boolean | `false` | Required guard before binding a non-loopback `host`. |
| `apiKey` | string | _unset_ | Optional bearer token. Inline config remains accepted for compatibility, but new source configs should omit it and set `MONO_AGENT_TUI_API_KEY` in `.env`; the registry never carries secrets. |

## Environment variables

| Env var | Maps to |
| --- | --- |
| `MONO_AGENT_TUI_ENABLED` | `tui.enabled` |
| `MONO_AGENT_TUI_HOST` | `tui.host` |
| `MONO_AGENT_TUI_PORT` | `tui.port` |
| `MONO_AGENT_TUI_BASE_PATH` | `tui.basePath` |
| `MONO_AGENT_TUI_ALLOW_NON_LOOPBACK` | `tui.allowNonLoopback` |
| `MONO_AGENT_TUI_API_KEY` | `tui.apiKey` |

Keep the bearer value in `.env` (or an exported environment variable). `mono-agent tui` resolves the effective value automatically without putting it in the trace-source registry.

## Conversational endpoints

`GET {basePath}/v1/info` advertises transport capabilities. In addition to the
existing attachment fields, `capabilities.askUser` tells browser clients that
the agent supports structured pending-question exchange and
`capabilities.liveInput` advertises active-turn follow-up settlement.

- `POST {basePath}/v1/turns` starts a streamed turn.
- `GET {basePath}/v1/conversations/:id/ask` returns the pending `AskUser`
  snapshot or `{ "ask": null }`.
- `POST {basePath}/v1/conversations/:id/ask` submits the snapshot's interaction
  id plus one or more consecutive complete answers, resuming the existing turn.
- `POST {basePath}/v1/conversations/:id/cancel` cancels the turn and any pending
  AskUser interaction.
- `POST {basePath}/v1/conversations/:id/live-input` offers one bounded
  `{ id, text, receivedAt }` follow-up to the active run and waits for its
  `applied`, `requeue`, or `discarded` settlement.

An `applied` settlement is also visible on the still-open turn stream as one
completed synthetic tool lifecycle named `↪️ Steered: “<safe preview>”`, with
result `Applied to current run`. The full guidance text is not repeated in the
event metadata or tool arguments. Other settlements emit no such lifecycle.

Ask submission is conversation-bound and rejects expired, completed, or
mismatched interaction ids. The endpoint remains subject to the same loopback,
non-loopback opt-in, and optional bearer-key policy as streamed turns.

## Endpoints & wire protocol

| Endpoint | Purpose |
| --- | --- |
| `GET {basePath}/v1/info` | `{ schema, pid, capabilities:{attachments:true,liveInput?:true,historyAppend?:true,askUser?:true}, label?, model?, models?, modelOptions?, effort? }` — identity, additive transport support, model choices, and wire-schema version for skew detection. `effort` is the statically configured reasoning-effort level; per-run overrides arrive via the `run_config` runtime_telemetry event instead. |
| `POST {basePath}/v1/turns` | Body `{ conversationId, text, attachments?, metadata? }`. Responds with chunked `application/x-ndjson`, one frame per stream callback: `status`, `append`, `replace`, `event` (any `AgentStreamEvent`), then a terminal `finish` (final text + response metadata) or `error` (`cancelled` flagged). Attachment-only turns are accepted when advertised by `/v1/info`. A web client's `metadata.web.model` / `effort` values are preserved and mirrored into the shared `metadata.tui` request-override lane. Closing the socket aborts the in-flight turn. |
| `POST {basePath}/v1/conversations/:id/live-input` | Authenticated body `{ id, text, receivedAt }`, with text capped at 8,000 characters. Returns `unavailable` immediately when there is no compatible active responder, otherwise holds the request until the offer settles as `applied`, `requeue`, or `discarded`. |
| `POST {basePath}/v1/conversations/:id/cancel` | Explicit cancel (`202`; `501` if the responder has no cancel). |
| `POST {basePath}/v1/conversations/:id/verbatim` | Authenticated body `{ text, idempotencyKey }`. Appends an already-delivered assistant message to durable history without a model turn (`200`; `501` if the responder has no history-append surface). Used by the web console's host-owned notification path. |

Frames are defined in `@mono-agent/agent-contracts` (`stream-wire`); parsing is tolerant in both directions, so version-skewed console/agent pairs keep talking (unknown frame kinds and event types pass through). A serialized event frame is capped at 256 KiB for its complete UTF-8 NDJSON line, including the newline. Above that cap, `assistant_thought` and `tool_call_started`/`tool_call_progress`/`tool_call_completed` payload fields are reduced, marked truncated, and remeasured. Any other oversized event variant — including `runtime_warning` or `runtime_telemetry` — and any reducible event whose minimal form still does not fit because of metadata or invariant fields becomes a small `oversized_event` marker instead. Other frame kinds do not use this cap. Replay does not restore the omitted tail: the JSONL recorder separately applies sensitive-key redaction, scans retained free text for high-confidence credential shapes, and caps each event string at 4,096 bytes by default. It buffers events in RAM and replaces the events file only at terminal `finish()`/`fail()`. A crash before that boundary can therefore leave no in-flight events to replay. The tool-bloat guard may separately save oversized tool-result blocks under `tool-output/` when its persistence callback succeeds; those files are not the run's JSONL event stream and do not recover arbitrary streamed payloads. See the [artifact write-boundary contract](/observability/artifacts-and-traces/).

How the endpoint is discovered: the running channel's summary (`baseUrl`) is folded into the agent's trace-source manifest at `metadata.channels.tui.baseUrl`, which `mono-agent tui` reads from the registry.

## Concurrency & security

- A console conversation uses its own `conversationId`, so it runs concurrently with every other channel; reusing an existing id (e.g. a Telegram conversation's) is possible and queues behind that conversation's in-flight turn.
- Managed macOS configuration uses a separate opaque configuration conversation id and never reuses the ordinary chat id. The request-scoped proposal extension rotates after each proposal/review or no-change outcome while the console remains visibly in SELF-CONFIG; it never turns a follow-up into ordinary chat.
- Loopback-only by default; binding further requires `allowNonLoopback` **and** should always pair with `apiKey`. Remember this endpoint streams tool arguments and results: the event-frame cap reduces oversized payloads but is not a redaction boundary, so this remains an operator surface by design.

## Related

- [Terminal UI](/observability/tui/) and [web console](/observability/web-console/) — the consoles that consume this endpoint.
- [Channels overview](/channels/) — shared lifecycle and status lines.
- [OpenAI-compatible API](/channels/openai-api/) — the lossy-but-standard HTTP alternative for third-party clients.

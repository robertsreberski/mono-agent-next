---
title: "OpenAI-compatible API"
description: "Expose the supported Chat Completions subset for Open WebUI and other clients, with explicit SSE, JSON, session, image, and compatibility behavior."
sidebar:
  order: 5
---

This channel exposes your agent through a deliberate subset of the OpenAI Chat
Completions protocol. It supports model discovery, JSON completions, SSE
streaming, and selected text/image request shapes for clients such as Open
WebUI, OpenAI SDKs, LangChain, and `curl`; it is not a general OpenAI API emulator.

Coverage: `config` (the entire surface is enabled and tuned from the `openaiApi` section of `mono-agent.config.json`).

## Configuration

```json
{
  "openaiApi": {
    "enabled": true,
    "host": "127.0.0.1",
    "port": 4040,
    "basePath": "/v1",
    "allowNonLoopback": false,
    "modelId": "my-agent"
  }
}
```

| Key | Type | Default | Purpose |
| --- | --- | --- | --- |
| `enabled` | boolean | `false` | Opt-in. When `false` the HTTP server is not started. |
| `host` | string | `127.0.0.1` | Bind address. Loopback by default. |
| `port` | integer | `0` | TCP port (0–65535); `0` selects a free port. |
| `basePath` | string | `/v1` | Path prefix; serves `<basePath>/models`, `<basePath>/chat/completions`, and direct `POST <basePath>`. Must be an absolute path with no query or hash. |
| `allowNonLoopback` | boolean | `false` | Required guard before binding a non-loopback `host`. See the warning below. |
| `modelId` | string | `agent` | The model id advertised in `/v1/models` and accepted in the request `model` field. |
| `apiKey` | string | _unset_ | Optional bearer token clients must present as `Authorization: Bearer <apiKey>`. Prefer `MONO_AGENT_OPENAI_API_KEY` in an owner-only `.env`; when unset, no auth is enforced. |

:::caution
Binding to a non-loopback `host` (anything other than `127.0.0.1`/`localhost`) requires both `allowNonLoopback: true` and a non-empty `apiKey`. Startup fails closed if either guard is missing. Prefer a reverse proxy with TLS when the endpoint crosses an untrusted network.
:::

Keep the bearer outside committed JSON. Create the invocation folder's `.env`
with owner-only permissions (`chmod 600 .env`) and add:

```dotenv
MONO_AGENT_OPENAI_API_KEY=<strong-client-bearer>
```

## Environment variables

Every key has a matching `MONO_AGENT_*` override, applied on top of the JSON config:

| Env var | Maps to |
| --- | --- |
| `MONO_AGENT_OPENAI_API_ENABLED` | `openaiApi.enabled` |
| `MONO_AGENT_OPENAI_API_HOST` | `openaiApi.host` |
| `MONO_AGENT_OPENAI_API_PORT` | `openaiApi.port` |
| `MONO_AGENT_OPENAI_API_BASE_PATH` | `openaiApi.basePath` |
| `MONO_AGENT_OPENAI_API_ALLOW_NON_LOOPBACK` | `openaiApi.allowNonLoopback` |
| `MONO_AGENT_OPENAI_API_MODEL_ID` | `openaiApi.modelId` |
| `MONO_AGENT_OPENAI_API_KEY` | `openaiApi.apiKey` |

See [Environment variables](/config/env-vars/) for precedence rules across config layers.

## Endpoints

The examples use the default `/v1` base path. If `basePath` changes, substitute
that value in every route below.

### `GET /v1/models`

Returns a single model entry whose `id` is your configured `modelId`. Clients use this to populate model pickers.

```bash
curl http://127.0.0.1:4040/v1/models \
  -H "Authorization: Bearer sk-..."
```

### `POST /v1/chat/completions`

Supported Chat Completions request. Set `stream: true` to receive
`text/event-stream` chunks followed by `data: [DONE]`. When `stream` is false or
omitted, the endpoint waits and returns one JSON `chat.completion` object.
Telegram and Slack's final-only delivery defaults do not affect this HTTP choice.

For clients that post to their configured API base URL directly, `POST /v1` is
an alias for the same handler. `GET /v1` is not model discovery; clients should
continue to call `GET /v1/models`.

Genuine assistant-thought events are emitted as `delta.reasoning_content`. Tool starts are not converted into synthetic thoughts such as `Running Bash...`; completed host-owned tools remain available as Open WebUI tool-detail blocks. This keeps reasoning content semantic while still exposing structured tool execution.

```bash
curl http://127.0.0.1:4040/v1/chat/completions \
  -H "Authorization: Bearer sk-..." \
  -H "Content-Type: application/json" \
  -d '{
    "model": "my-agent",
    "stream": true,
    "messages": [{ "role": "user", "content": "Summarize today’s standup." }]
  }'
```

Common sampling parameters (`temperature`, `top_p`, `max_tokens`, `max_completion_tokens`, `stop`, `seed`, `logit_bias`, `presence_penalty`, and `frequency_penalty`) are accepted for protocol and request-metadata compatibility, but are not currently applied to the configured runtime. Absent parameters and explicit OpenAI defaults are quiet. Supplying any non-default value emits a names-only `runtime_warning` and continues with the runtime's configured values: streaming responses render it as a reasoning delta, while non-stream JSON responses expose the structured event in the additive `mono_agent.events` extension. As a result, Open WebUI sampling sliders are currently inert for mono-agent requests.

### Compatibility matrix

| Request or response surface | Support | Behavior |
| --- | --- | --- |
| `model` | Required | Must exactly match configured `modelId`; another value returns HTTP `400`. |
| Non-empty `messages` | Required | Each message needs a role and string or supported multipart content. |
| String content | Supported | Flattened into responder text according to session continuity below. |
| `text` content parts | Supported | Joined into responder text. |
| `image_url` content parts | Supported structurally | Every image remains on `imageAttachments`; base64 `data:` images also enter shared attachments. Remote/file URLs are not downloaded. |
| `stream: true` | Supported | SSE Chat Completions chunks plus `[DONE]`. |
| `stream: false` or omitted | Supported | One JSON Chat Completions response. |
| Sampling fields listed above | Accepted, not applied | Preserved in metadata; non-default values produce a names-only warning. |
| `tools`, `tool_choice`, `functions`, `function_call`, `response_format`, `audio`, `modalities` | Rejected | Presence of any field returns HTTP `400` `invalid_request_error`. |
| Message-level `tool_calls` or `function_call` | Rejected | Host-owned tools are never delegated to the API client. |
| Other content parts, including `input_audio` | Rejected | Only `text` and `image_url` are accepted. |
| Host-owned tool progress | Open WebUI extension | Completed tools render as bounded details blocks; no `delta.tool_calls` or `finish_reason: "tool_calls"`. |
| Responses, Embeddings, Files, Images, or Audio endpoints | Not implemented | Outside this Chat Completions package boundary. |

## Session continuity

The OpenAI protocol is stateless — clients commonly resend the transcript on
every call. With a stable chat-specific id, mono-agent lets the host's own
conversation history/session remain authoritative. On the first turn (no prior
assistant message in the submitted transcript), the full role-prefixed transcript
is forwarded once. On later turns, only user messages after the final assistant
message are forwarded, preventing duplicate context.

The conversation id is resolved from the first present of these, in order:

1. `metadata.conversation_id` / `metadata.conversationId` / `metadata.chat_id` / `metadata.chatId` in the request body
2. `conversation_id` / `conversationId` at the top level of the request body
3. The `X-OpenWebUI-Chat-Id` request header
4. The `X-Conversation-Id` request header
5. Request-body `user`

Open WebUI strips metadata from the bodies it forwards but, when `ENABLE_FORWARD_USER_INFO_HEADERS` is enabled, sends the chat id as `X-OpenWebUI-Chat-Id` — which is why the header fallbacks exist. `X-Conversation-Id` is the generic equivalent for other proxies.

`user` is a final compatibility fallback: it becomes the conversation id, but
because it normally identifies a person rather than one chat, the adapter keeps
full-transcript flattening instead of latest-turn extraction. If neither a
chat-specific id nor `user` is available, each request gets a fresh
`openai-api:<requestId>` conversation. For reliable multi-turn continuity,
forward a stable chat-specific id through body metadata or one of the headers.

The agent's [memory](/memory/capture-and-recall/) and
[sessions](/runtime/sessions-concurrency/) handle host-owned history. The same
[Tool Policy](/tools/policy/) and runtime guards apply to API turns as to any
other channel.

## Open WebUI integration

1. Start your agent with `openaiApi.enabled: true` (e.g. `host: 127.0.0.1`, `port: 4040`).
2. In Open WebUI, go to **Settings → Connections → OpenAI API** and add a connection:
   - **API Base URL**: `http://127.0.0.1:4040/v1`
   - **API Key**: the value of `MONO_AGENT_OPENAI_API_KEY`; when the loopback-only endpoint has no key, use any non-empty client placeholder.
3. Save. Open WebUI calls `/v1/models` and your `modelId` appears in the model picker — select it.
4. To preserve multi-turn continuity, enable `ENABLE_FORWARD_USER_INFO_HEADERS=true` in Open WebUI so it forwards `X-OpenWebUI-Chat-Id`. Each Open WebUI chat then maps to one persistent agent conversation.

If Open WebUI and the agent run on different hosts, set `allowNonLoopback: true`, bind a reachable `host`, and protect the port with `MONO_AGENT_OPENAI_API_KEY` (and ideally a TLS-terminating proxy). Wildcard binds report concrete loopback, private-LAN, and Tailscale base URLs; use one of those rather than `0.0.0.0` as a client URL.

For an end-to-end walkthrough, see the playbook [OpenAI endpoint with Open WebUI](/playbooks/openai-endpoint-open-webui/).

## Related

- [Channels overview](/channels/)
- [Delivery and send tools](/channels/delivery-and-send-tools/)
- [Sessions and concurrency](/runtime/sessions-concurrency/)
- [Capture and recall](/memory/capture-and-recall/)

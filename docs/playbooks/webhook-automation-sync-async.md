---
title: "Webhook Automation with Sync + Async Endpoints"
description: "Configure authenticated synchronous and asynchronous webhook endpoints for automation workflows."
sidebar:
  order: 5
---

This playbook wires the agent into an automation pipeline over HTTP: a fast **sync** endpoint that returns the answer in the response body, and a long-running **async** endpoint that returns `202` plus a status URL you poll until the job completes. It also shows how to run several named endpoints on one shared port, defined inline or as `webhook/*.md` files.

## Who this is for

Backend developers integrating the agent into a pipeline — calling it from scripts, CI jobs, or other services rather than a chat channel.

## Goal

Accept fast sync HTTP calls and long-running async jobs (202 + status polling) across multiple named endpoints, some defined as markdown files.

## Features used

- [`webhook.http-invoke`](/channels/webhook/) — `POST` a JSON body, the agent runs a turn.
- [`webhook.sync-async-modes`](/channels/webhook/) — `sync` returns the body inline; `async` returns `202` + a status URL to poll.
- [`webhook.endpoints-dir`](/channels/webhook/) — multiple named endpoints inline (`webhook.endpoints[]`) or as `*.md` files under `webhook.dir`.
- [`harness.external-summary-safety`](/observability/artifacts-and-traces/) — response/status metadata excludes the private compiled `systemPrompt`; local recorder artifacts retain it.
- [`channel.native-notify`](/channels/delivery-and-send-tools/#native-proactive-notification-cronwebhook-turns) — an endpoint with `notify: true` delivers its final answer back into a chat verbatim (no agent-facing tool involved).

The first three are **config** coverage (the `webhook` section plus `MONO_AGENT_WEBHOOK_*` env overrides); native notification is opt-in per endpoint via `notify: true`.

## Configuration

`mono-agent init` already enables the webhook channel with a single sync endpoint. The config below adds a second async endpoint and a per-endpoint `prompt`. Each endpoint needs a **unique `name` and a unique `path`**; a duplicate of either (across inline config and folder files) is a hard configuration error.

```json
{
  "runtime": {
    "model": "claude:claude-sonnet-4-6"
  },
  "webhook": {
    "enabled": true,
    "host": "127.0.0.1",
    "port": 8080,
    "defaultMode": "sync",
    "endpoints": [
      {
        "name": "invoke",
        "path": "/webhook/invoke",
        "mode": "sync",
        "prompt": "Respond to this request:"
      },
      {
        "name": "jobs",
        "path": "/webhook/jobs",
        "mode": "async"
      }
    ],
    "retentionMs": 300000,
    "maxStoredRequests": 100
  }
}
```

The matching env overrides are `MONO_AGENT_WEBHOOK_HOST`, `MONO_AGENT_WEBHOOK_PORT`, `MONO_AGENT_WEBHOOK_DEFAULT_MODE`, `MONO_AGENT_WEBHOOK_API_KEY`, `MONO_AGENT_WEBHOOK_RETENTION_MS`, `MONO_AGENT_WEBHOOK_MAX_STORED_REQUESTS`, `MONO_AGENT_WEBHOOK_NOTIFY`, `MONO_AGENT_WEBHOOK_NOTIFY_CONVERSATION_ID`, and `MONO_AGENT_WEBHOOK_ENDPOINTS_JSON` (the `endpoints` array as a JSON string). Set `MONO_AGENT_WEBHOOK_API_KEY` to require `Authorization: Bearer <key>` on both invocation and status polling; it is optional for this loopback recipe.

:::caution
The server binds to loopback by default. A non-loopback `host` (e.g. `0.0.0.0`) is rejected unless `allowNonLoopback: true` and a non-empty `MONO_AGENT_WEBHOOK_API_KEY` are both configured. The built-in bearer is necessary but public exposure still needs TLS, rate limiting, and any provider-specific verification at a reverse proxy or integration boundary you control.
:::

### Endpoints as markdown files

Alongside (or instead of) `webhook.endpoints[]`, author one `*.md` file per endpoint in `webhook.dir` (default `webhook/`). YAML frontmatter holds routing metadata; the markdown body becomes the endpoint's `prompt`, which is **prepended to the incoming request `text`** before the turn runs.

```yaml
---
path: /webhook/triage
name: triage
mode: async
---
You are triaging an inbound support ticket. Classify and summarize.
```

`path` is required; `name` defaults to the filename stem, `mode` to `defaultMode`, `enabled` to `true`, and `notify` to `false`. This mirrors how [cron](/channels/cron/) jobs can be authored as `cron/*.md` files.

## Native notification from an async webhook

An operator-owned automation can push an async webhook run's own final answer into a configured chat — no agent-facing tool involved. Set `notify: true` on the endpoint; its final answer is then delivered **verbatim** to a destination resolved in this order:

1. the endpoint's configured `notifyConversationId`, if set; otherwise
2. the inbound request's own `conversationId`, when a trusted caller deliberately supplies a deliverable chat (`telegram:…` / `slack:…`); otherwise
3. the single notify-capable destination, when exactly one exists.

For example, an authenticated automation that already owns its destination can call the endpoint with a fixed `conversationId`; when the endpoint finishes, its answer is recorded in that conversation's history. The destination remains bounded by the owning channel's allowlist, and a payload-supplied id outside `telegram.allowedChatIds` / `slack.allowedChannelIds` (or `allowAll*`) is refused. If there is nothing worth sending, the agent replies with exactly `NOTHING_TO_REPORT` and no notification is delivered.

This generic webhook feature does **not** prove that a later result belongs to the chat that initiated external work. For that workflow, select the external MCP service under `tools.continuationServers` and use a [durable continuation](/tools/durable-continuations/). The host then retains the origin/thread and gives the service an opaque claim capability; the model does not copy a conversation ID or choose the callback destination. See [Native proactive notification](/channels/delivery-and-send-tools/#native-proactive-notification-cronwebhook-turns).

## Steps

1. `mono-agent init --model claude:claude-sonnet-4-6` — the webhook channel is enabled by `init` already.
2. Add multiple endpoints in `webhook.endpoints[]` and/or `webhook/*.md` files, giving each a unique `name` AND a unique `path`.
3. Run `mono-agent validate`, then `mono-agent start`.
4. `curl` the sync endpoint for an immediate response body; `curl` the async endpoint for a `202` plus a status URL.
5. Poll the async status URL until the job reports complete.
6. Confirm async retention behavior — the status entry vanishes after `retentionMs` (300000 ms / 5 minutes above).
7. Inspect sync, async status, and any result callback metadata and confirm `metadata.summary.systemPrompt` is absent even when using a custom responder.

## Smoke test

:::tip
`curl -X POST /webhook/invoke` and inspect the response body; `curl -X POST /webhook/jobs`, get `202` + a status URL, then poll that URL until the result is returned. When `MONO_AGENT_WEBHOOK_API_KEY` is set, add `-H "Authorization: Bearer $MONO_AGENT_WEBHOOK_API_KEY"` to every POST and status poll.
:::

## Related

- [Webhook channel](/channels/webhook/) — full key reference, endpoint files, prompts, and env overrides.
- [Cron](/channels/cron/) — scheduled turns; shares the `*.md` authoring pattern and the `prompt` concept.
- [Delivery and send tools](/channels/delivery-and-send-tools/) — how answers are returned across channels.
- [Durable continuations](/tools/durable-continuations/) — origin-bound later results for chat-delegated work.
- [Config blueprint](/config/blueprint/) — the annotated `mono-agent.config.json`.
- [mono-agent-composer skill](https://github.com/robertsreberski/mono-agent/blob/main/packages/agent-app/skills/mono-agent-composer/SKILL.md) — build this agent from one config.

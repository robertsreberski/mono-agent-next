---
title: "A2A (Agent-to-Agent)"
description: "Configure the A2A provider plugin, its Agent Card and network boundary, and understand where programmatic consumer calls begin."
sidebar:
  order: 6
---

This page covers the **provider** side of the A2A channel: how mono-agent serves your agent over the [A2A protocol](https://a2a-protocol.org) so other agents can discover and call it. The channel is provided by the external `@mono-agent/a2a-adapter` package and loaded through `channels.plugins[]`. It publishes an Agent Card, accepts messages over JSON-RPC and REST, and streams responses. Calling *remote* A2A agents (the consumer side) is programmatic — see [A2A consumer](/programmatic/a2a-consumer/).

Coverage: **config**. The provider is fully described by the A2A plugin entry's `config.provider`, `config.agent`, and `config.skill` settings in `mono-agent.config.json`.

## What the provider serves

When the A2A plugin entry has `config.enabled` set to `true` (or the legacy `config.provider.enabled` — the root flag wins when both are set), `mono-agent start` binds an HTTP server that exposes three endpoints relative to the bound host (or `publicBaseUrl` when fronted by a proxy):

| Path | Purpose |
| --- | --- |
| `/.well-known/agent-card.json` | Agent Card for discovery (name, description, version, skill, capabilities) |
| `/a2a/json-rpc` | JSON-RPC message endpoint (`message/send`, `message/stream`) |
| `/a2a/rest` | REST message endpoint |

The Agent Card advertises `capabilities.streaming: true`, so callers can stream incremental output over JSON-RPC. Each inbound message runs one agent turn against your configured runtime, memory, and tools — the same engine that backs every other channel.

## Scope

The provider is deliberately **text/task only**. It supports plain-text message exchange and task-style turns, and nothing more. The following A2A protocol features are intentionally not implemented:

- No agent registry / catalog
- No gRPC transport (HTTP/JSON only)
- No push notifications
- No signed Agent Cards
- No file exchange (text parts only)

:::note
If you need richer transport semantics, treat the provider as a stable text gateway and compose the missing pieces in front of it. The surface is kept small on purpose so it stays predictable for other agents to call.
:::

## Configuration

Set `MONO_AGENT_A2A_BEARER_TOKEN` in the agent's `.env` when
`requireBearer` is enabled. The source-config example intentionally omits the
credential.

```json
{
  "channels": {
    "plugins": [
      {
        "package": "@mono-agent/a2a-adapter",
        "id": "a2a",
        "config": {
          "enabled": true,
          "provider": {
            "host": "127.0.0.1",
            "port": 4201,
            "publicBaseUrl": "https://agent.example.com",
            "allowNonLoopback": true,
            "requireBearer": true,
            "maxRequestBytes": 50000000,
            "idempotency": {
              "namespace": "my-agent-production",
              "retentionMs": 2592000000,
              "maxRecords": 10000
            }
          },
          "agent": {
            "name": "My Agent",
            "description": "What it does.",
            "version": "0.1.0",
            "providerOrganization": "Acme",
            "providerUrl": "https://acme.example.com"
          },
          "skill": {
            "id": "main",
            "name": "Main",
            "description": "Primary skill.",
            "tags": ["agent"]
          }
        }
      }
    ]
  }
}
```

### `config.provider`

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `enabled` | boolean | `false` | Opt-in. When off the channel reports `disabled`, not `waiting`. |
| `host` | string | `127.0.0.1` | Bind address. Non-loopback requires `allowNonLoopback: true`. |
| `port` | number | `4201` | TCP port (0–65535). |
| `publicBaseUrl` | string | — | Absolute URL written into the Agent Card endpoint URLs when fronted by a reverse proxy. |
| `allowNonLoopback` | boolean | `false` | Must be `true` to bind a non-loopback `host` or advertise a non-loopback `publicBaseUrl`. |
| `requireBearer` | boolean | `false` | Require `Authorization: Bearer <token>` on `/a2a/json-rpc` and `/a2a/rest`. |
| `bearerToken` | string | — | The expected token. Required when `requireBearer` is `true`. |
| `maxRequestBytes` | integer | A2A SDK default (100 KiB) | Optional JSON request-body ceiling for JSON-RPC and REST. Range: 1024–100000000 bytes. Authentication runs before body parsing. |
| `idempotency.namespace` | string | — | Explicitly enables durable logical-dispatch idempotency and defines the stable authenticated principal boundary. Never derive it from URL/version/token. |
| `idempotency.stateDir` | string | derived owner-only path | Durable receipt/tombstone directory. Relative paths resolve from the agent cwd. |
| `idempotency.retentionMs` | integer | `2592000000` | Full terminal-result replay horizon; compact tombstones remain permanent. |
| `idempotency.maxRecords` | integer | `10000` | Hard unique-key admission capacity; exhaustion fails closed. |

The block is all-or-nothing: configuring any `idempotency.*` field requires a
non-empty `idempotency.namespace`. Partial configuration fails validation rather
than starting without protection.

### `config.agent`

Populates the identity block of the Agent Card.

| Key | Required | Notes |
| --- | --- | --- |
| `name` | yes when no root name is available | Human-readable Agent Card name. Defaults from root `agent.name` / `MONO_AGENT_NAME`; plugin `config.agent.name` / `MONO_AGENT_A2A_AGENT_NAME` wins. |
| `description` | yes | What the agent does. |
| `version` | yes | Agent version string (e.g. `0.1.0`). |
| `providerOrganization` | no | Organization that operates the agent. Emitted only when `providerUrl` is also set. |
| `providerUrl` | no | URL for the operating organization. Emitted only when `providerOrganization` is also set. |

### `config.skill`

A single advertised skill on the Agent Card.

| Key | Required | Notes |
| --- | --- | --- |
| `id` | yes | Stable skill identifier (e.g. `main`). |
| `name` | yes | Display name. |
| `description` | yes | What the skill does. |
| `tags` | no | String array for categorization. |

## Environment variables

Every key has a `MONO_AGENT_*` override. Strings split on commas where the value is a list.

| Env var | JSON key |
| --- | --- |
| `MONO_AGENT_A2A_ENABLED` | plugin `config.enabled` (canonical; wins over the legacy form) |
| `MONO_AGENT_A2A_PROVIDER_ENABLED` | plugin `config.provider.enabled` (legacy; still honored) |
| `MONO_AGENT_A2A_HOST` | plugin `config.provider.host` |
| `MONO_AGENT_A2A_PORT` | plugin `config.provider.port` |
| `MONO_AGENT_A2A_PUBLIC_BASE_URL` | plugin `config.provider.publicBaseUrl` |
| `MONO_AGENT_A2A_ALLOW_NON_LOOPBACK` | plugin `config.provider.allowNonLoopback` |
| `MONO_AGENT_A2A_REQUIRE_BEARER` | plugin `config.provider.requireBearer` |
| `MONO_AGENT_A2A_BEARER_TOKEN` | plugin `config.provider.bearerToken` |
| `MONO_AGENT_A2A_MAX_REQUEST_BYTES` | plugin `config.provider.maxRequestBytes` |
| `MONO_AGENT_A2A_IDEMPOTENCY_NAMESPACE` | plugin `config.provider.idempotency.namespace` |
| `MONO_AGENT_A2A_IDEMPOTENCY_STATE_DIR` | plugin `config.provider.idempotency.stateDir` |
| `MONO_AGENT_A2A_IDEMPOTENCY_RETENTION_MS` | plugin `config.provider.idempotency.retentionMs` |
| `MONO_AGENT_A2A_IDEMPOTENCY_MAX_RECORDS` | plugin `config.provider.idempotency.maxRecords` |
| `MONO_AGENT_A2A_AGENT_NAME` | plugin `config.agent.name` (wins over root `agent.name` / `MONO_AGENT_NAME`) |
| `MONO_AGENT_A2A_AGENT_DESCRIPTION` | plugin `config.agent.description` |
| `MONO_AGENT_A2A_AGENT_VERSION` | plugin `config.agent.version` |
| `MONO_AGENT_A2A_PROVIDER_ORGANIZATION` | plugin `config.agent.providerOrganization` |
| `MONO_AGENT_A2A_PROVIDER_URL` | plugin `config.agent.providerUrl` |
| `MONO_AGENT_A2A_SKILL_ID` | plugin `config.skill.id` |
| `MONO_AGENT_A2A_SKILL_NAME` | plugin `config.skill.name` |
| `MONO_AGENT_A2A_SKILL_DESCRIPTION` | plugin `config.skill.description` |
| `MONO_AGENT_A2A_SKILL_TAGS` | plugin `config.skill.tags` (comma-separated) |
| `MONO_AGENT_A2A_REMOTE_AGENT_URLS` | plugin `config.consumer.remoteAgentUrls` (comma-separated) |
| `MONO_AGENT_A2A_DEFAULT_REMOTE_AGENT_URL` | plugin `config.consumer.defaultRemoteAgentUrl` |
| `MONO_AGENT_A2A_CONSUMER_BEARER_TOKEN` | plugin `config.consumer.bearerToken` |
| `MONO_AGENT_A2A_TIMEOUT_MS` | plugin `config.consumer.timeoutMs` |

## Network security

By default the provider binds loopback (`127.0.0.1`) and runs without auth — safe for local development and same-host agent-to-agent calls.

To expose the provider publicly you must opt in on two axes:

1. Set `allowNonLoopback: true` to bind a non-loopback `host` or advertise a non-loopback `publicBaseUrl`. Without it, start fails with an explicit error rather than silently binding `0.0.0.0`.
2. Set `requireBearer: true` with a `bearerToken` so callers must present `Authorization: Bearer <token>`. When `requireBearer` is on but no token is configured, start fails.

:::caution
A2A speaks plaintext HTTP. Terminate **HTTPS** at a reverse proxy in front of the provider, set `publicBaseUrl` to the public `https://` URL, and always pair public exposure with `requireBearer`. Keep `bearerToken` in `.env` (`MONO_AGENT_A2A_BEARER_TOKEN`), never in committed config.
:::

## Startup status

`mono-agent start` prints one status line for the A2A channel:

- `running` with the bound endpoint facts (Agent Card / JSON-RPC / REST URLs) when enabled and valid.
- `waiting_for_config` naming the exact missing setting (e.g. a required `config.agent.name`).
- `disabled` when plugin `config.enabled` (or the legacy `config.provider.enabled`) is `false`.
- `failed` with the reason (e.g. non-loopback bind without `allowNonLoopback`).

Run `mono-agent validate` first for a per-section report. Config is JSON-first — edit `mono-agent.config.json` and run `mono-agent restart` to apply.

## Tools and behavior

Inbound A2A messages run the same turn pipeline as other channels, so [tool policy](/tools/policy/), [MCP servers](/tools/mcp/), [sandbox](/tools/sandbox/), [memory](/memory/capture-and-recall/), and [sessions/concurrency](/runtime/sessions-concurrency/) all apply. See the [channels overview](/channels/) for cross-channel concepts.

## Calling remote agents

The provider only serves *your* agent. To have your agent call *other* A2A agents, put consumer defaults under the same A2A plugin entry's `config.consumer` and invoke them programmatically with `createA2AConsumerResponder`, `sendA2AMessage`, or `dispatchA2AMessage`. Loading consumer config does not add a tool or autonomously delegate work; this remains a **code** path — see [A2A consumer](/programmatic/a2a-consumer/).

## Related

- [A2A provider and consumer playbook](/playbooks/a2a-provider-and-consumer/) — end-to-end two-agent setup.
- [A2A consumer (programmatic)](/programmatic/a2a-consumer/) — calling remote agents.
- [Multi-agent orchestration](/programmatic/multi-agent/) — composing agents that delegate over A2A.
- [Config blueprint](/config/blueprint/) and [environment variables](/config/env-vars/).

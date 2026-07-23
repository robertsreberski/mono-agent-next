---
title: "A2A Provider + Consumer Pair"
description: "Publish one mono-agent as an authenticated A2A provider and call it from another agent programmatically."
sidebar:
  order: 7
---

This playbook stands up two mono-agents that talk to each other over the Agent-to-Agent (A2A) protocol: agent A publishes an Agent Card with bearer auth (the **provider**), and agent B discovers and calls it (the **consumer**). A2A is loaded through `channels.plugins[]`; the provider side is config-driven, while the consumer side stores its settings in plugin config but invokes remote agents programmatically.

## Who this is for

Platform integrators connecting two agents over A2A.

## Goal

Publish agent A as an A2A provider (Agent Card discovery, bearer) and configure agent B to discover and call it as a consumer.

## Features used

- [`a2a.provider`](/channels/a2a/) — A2A provider with Agent Card discovery, JSON-RPC + REST, streaming, optional bearer (`channels.plugins[]` config).
- [`a2a.consumer`](/programmatic/a2a-consumer/) — calling remote A2A agents (discovery + sendMessage); settings live in plugin config, invocation is `code` via `createA2AConsumerResponder` / `sendA2AMessage`.
- [`channel.plugins`](/programmatic/custom-channels/) — external channel packages loaded by name.

## Configuration

The block below is a single `mono-agent.config.json` carrying **both** sides for illustration; in practice the provider keys go in agent A's plugin entry and the `consumer` keys go in agent B's plugin entry. The provider keys are plugin `config.provider`, `config.agent`, and `config.skill`; the consumer keys are plugin `config.consumer`.

Put the provider token in agent A's `.env` as
`MONO_AGENT_A2A_BEARER_TOKEN` and the consumer token in agent B's `.env` as
`MONO_AGENT_A2A_CONSUMER_BEARER_TOKEN`. The source-config example omits both
credentials.

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
            "requireBearer": true,
            "idempotency": {
              "namespace": "research-production",
              "retentionMs": 2592000000,
              "maxRecords": 10000
            }
          },
          "agent": {
            "name": "Research Agent",
            "description": "Does research.",
            "version": "0.1.0"
          },
          "skill": {
            "id": "research",
            "name": "Research",
            "description": "Web research",
            "tags": ["research"]
          },
          "consumer": {
            "remoteAgentUrls": ["http://127.0.0.1:4201"],
            "defaultRemoteAgentUrl": "http://127.0.0.1:4201",
            "timeoutMs": 30000
          }
        }
      }
    ]
  }
}
```

Keep bearer tokens out of the file by supplying them via env vars:
`MONO_AGENT_A2A_BEARER_TOKEN` maps to plugin
`config.provider.bearerToken`, and
`MONO_AGENT_A2A_CONSUMER_BEARER_TOKEN` maps to plugin
`config.consumer.bearerToken`. `MONO_AGENT_A2A_ENABLED=true` maps to plugin
`config.enabled` (the legacy `MONO_AGENT_A2A_PROVIDER_ENABLED` /
`config.provider.enabled` form is still honored; the root flag wins when both
are set). The idempotency namespace is a reviewed stable
authenticated-principal boundary, not a URL, version, or secret. See
[the environment-variable reference](/config/env-vars/).

:::caution
When the provider sits behind a proxy or is reached from another host, set plugin `config.provider.publicBaseUrl` so the Agent Card advertises the right URL, and `config.provider.allowNonLoopback: true` to bind beyond `127.0.0.1`. Always pair non-loopback exposure with `requireBearer: true`.
:::

## Steps

1. Provider: run `mono-agent init`, add an `@mono-agent/a2a-adapter` entry under `channels.plugins[]` with `config.provider`, `config.agent`, and `config.skill`, set `requireBearer: true` plus `MONO_AGENT_A2A_BEARER_TOKEN` in `.env`, and choose a stable `provider.idempotency.namespace` for paid/non-repeatable work; then `mono-agent validate` and `mono-agent start`.
2. Confirm the Agent Card is reachable at the provider port (e.g. `http://127.0.0.1:4201`).
3. Consumer: configure plugin `config.consumer.remoteAgentUrls` (and `defaultRemoteAgentUrl`/`timeoutMs`) plus `MONO_AGENT_A2A_CONSUMER_BEARER_TOKEN` in `.env`, or compose `createA2AConsumerResponder` programmatically — invoking remote agents is code-only, see [the programmatic A2A consumer guide](/programmatic/a2a-consumer/).
4. From the consumer, send text to the provider's Agent Card URL with the bearer token and the existing logical dispatch id as `idempotencyKey` (or resolve it with `idempotencyKeyForRequest`).
5. Repeat the same keyed call and confirm the provider returns the same task/result without a second responder invocation.

## Smoke test

:::tip
Send the same keyed message twice to the provider's Agent Card URL (with bearer) using `sendA2AMessage()` / the consumer responder; confirm a real response and one responder invocation.
:::

## Related

- [A2A channel (provider)](/channels/a2a/)
- [A2A consumer (programmatic)](/programmatic/a2a-consumer/)
- [Multi-agent orchestration](/programmatic/multi-agent/)
- [Channels overview & opt-in flags](/channels/)
- [Environment variables](/config/env-vars/)
- [Config blueprint](/config/blueprint/)
- [Quickstart](/getting-started/quickstart/)

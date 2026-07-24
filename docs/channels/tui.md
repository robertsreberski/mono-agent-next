---
title: "Operator channel"
description: "Select the authenticated loopback endpoint used by standalone mono-agent operator products."
sidebar:
  order: 9
---

`@mono-agent/channel-operator` serves one running agent through the shared
`@mono-agent/operator` HTTP and NDJSON protocol. It is an explicitly selected
typed channel module, not a default-on `tui` config section, and it does not
embed either the terminal or browser product.

Coverage: `config` (`channels.operator` in `mono-agent.config.json`). The
existing `/channels/tui/` documentation path is retained for stable links; the
v1 config id is `operator`.

## Configuration

```json
{
  "channels": {
    "operator": {
      "$use": "@mono-agent/channel-operator",
      "listen": {
        "host": "127.0.0.1",
        "port": 0
      },
      "auth": {
        "token": {
          "$env": "MONO_AGENT_OPERATOR_TOKEN"
        }
      },
      "label": "Personal Agent"
    }
  }
}
```

| Key | Type | Default | Purpose |
| --- | --- | --- | --- |
| `listen.host` | string | `127.0.0.1` | Loopback address. Non-loopback addresses are rejected rather than enabled by an override. |
| `listen.port` | integer | `0` | `0` asks the operating system for an ephemeral port. |
| `auth.token` | `{$env}` secret | required | Bearer token resolved by Core before module validation. Literal source-config secrets are rejected by the schema boundary. |
| `label` | string | agent instance id | Optional human-readable label, capped at 128 printable characters. |

The resolved bearer must be a non-whitespace value from 32 through 4,096 bytes.
Put it in the selected environment source and expose only its variable name in
an owner-private discovery descriptor. Neither the channel nor the descriptor
persists the secret.

## Current endpoints

Every route requires bearer authentication.

| Endpoint | Purpose |
| --- | --- |
| `GET /v1/info` | Protocol, agent/process identity, and explicit capability flags. |
| `GET /v1/health` | Bounded channel health for the current process. |
| `POST /v1/turns` | Start one text turn and receive `application/x-ndjson`. |
| `POST /v1/conversations/:id/cancel` | Cancel active turns for that exact conversation. |

A turn begins with `accepted`, can emit assistant `delta` and `activity`
frames, and ends with exactly one `completed` or `error` frame. The selected
Core/runtime remains authoritative for model and effort validation. Closing the
client stream aborts the exact dispatch; explicit cancel, drain, and stop use
the same request signal.

The current channel advertises only controls backed by Core host methods:
cancellation, runtime overrides, attachments, replay-verified quotes, live
input, AskUser, proactive delivery, redacted config, replay, and health. Its
info response also exposes model hints derived only from strictly validated
configured routes. Conversation summaries retain explicit whitelisted
`cron`/`webhook` provenance from delivery metadata; renderers do not infer it
from conversation ids. An unsupported capability remains false and is not
simulated by a product.

## Protocol bounds and request security

- Turn, cancellation, live-input, and JSON-response bodies are capped at 1 MiB.
  AskUser answers have a dedicated 8 MiB cap so the maximum canonical
  3-question × 20-value answer remains representable after JSON escaping.
- Each serialized NDJSON frame is capped at 4 MiB so even a maximally populated
  canonical AskUser request remains representable after JSON escaping. A
  complete stream is capped at 8 MiB, with room reserved for a terminal frame.
- Mutation bodies require `Content-Type: application/json`.
- The channel accepts only its actual loopback authority and rejects cross-site
  browser requests and mismatched `Origin` values.
- The shared client accepts only literal loopback HTTP endpoints, rejects
  redirects, validates every object and frame strictly, and requires exactly
  one terminal frame.

This is an owner-equivalent operator surface. Loopback and bearer
authentication are both mandatory; the channel deliberately has no
`allowNonLoopback` or plaintext-LAN mode.

## Discovery ownership

`channel-operator` returns its actual endpoint after `start()`, but it does not
write a registry. The owning state/discovery lifecycle may publish an
owner-private `mono-agent.operator-registry.v1` descriptor containing agent id,
label, endpoint, token environment name, process id/start time, heartbeat, and
capabilities. `@mono-agent/operator` rejects unsafe directory modes, symlinks,
multi-link files, wrong ownership, and malformed descriptors. It marks stale
entries and excludes them from automatic selection; products bind a selected
endpoint's live agent id, PID, and process start time before use.

Until a host publishes that descriptor, standalone products can use a direct
endpoint. This PR does not imply completion of the later state/discovery
vertical.

## Related

- [Terminal operator](/observability/tui/) — standalone pi-tui product.
- [Web operator](/observability/web-console/) — standalone authenticated browser product.
- [v1 architecture](/reference/v1-architecture/) — dependency and product boundaries.

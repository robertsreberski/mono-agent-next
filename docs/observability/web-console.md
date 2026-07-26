---
title: "Standalone web operator"
description: "Run the browser product with an explicit access mode, separate config, and owner-private durable conversations."
sidebar:
  order: 5
---

`@mono-agent/web` is a standalone browser operator for one or more locally
registered agents. It has its own config, listener, process, access mode, and
durable state. It is never selected by `mono-agent.config.json`, and loading
agent config never starts it.

The browser talks only to this product. The product discovers agents and uses
the strict `@mono-agent/operator` client, reducer, identity binding, and action
eligibility; it does not parse agent NDJSON or implement a second operator
state machine.

## Configure and run

Create a strict `web.config.json`. Token mode keeps the secret in an environment
variable:

```json
{
  "$schema": "./.mono-agent/web.config.schema.json",
  "configVersion": 1,
  "listen": {
    "host": "127.0.0.1",
    "port": 5050
  },
  "auth": {
    "token": {
      "$env": "MONO_AGENT_WEB_AUTH_TOKEN"
    }
  },
  "allowInsecureHttp": false,
  "dataDirectory": "./.mono-agent/web",
  "agentRegistries": [
    "../example-agent/.mono-agent/trace-sources"
  ],
  "allowedHosts": [],
  "externalOrigins": []
}
```

Paths resolve relative to the config file. `agentRegistries` must contain at
least one directory. Literal bearer values and unknown config fields are
rejected.

For an owner-trusted network where a bearer login is intentionally unwanted,
select no-auth mode instead:

```json
{
  "configVersion": 1,
  "listen": { "host": "0.0.0.0", "port": 5050 },
  "auth": { "mode": "none" },
  "allowInsecureHttp": true,
  "allowedHosts": ["mickey-home.tail8a9beb.ts.net"],
  "dataDirectory": "./.mono-agent/web",
  "agentRegistries": ["../example-agent/.mono-agent/trace-sources"]
}
```

`auth` is a strict union: use exactly `{"token":{"$env":"NAME"}}` or
`{"mode":"none"}`. Mixing the two, adding auth fallbacks, or omitting `auth`
fails validation.

Start the foreground product:

```bash
MONO_AGENT_WEB_AUTH_TOKEN="replace-with-a-long-random-token" \
  node packages/web/dist/bin.js ./web.config.json
```

The default listener is `127.0.0.1:5050`. This package does not install an OS
service, configure Tailscale Serve, terminate TLS, or provide `start`/`restart`
lifecycle subcommands; a supervisor may run the foreground binary separately
from every agent.

<a id="security-boundary-trusted-network-no-login"></a>

## Browser access and request boundaries

In token mode, the resolved token must contain at least 16 characters. The
browser first probes bootstrap without credentials. A `401` switches it to the
login screen; after login it retains the token only in that origin's
`sessionStorage` and sends bearer authentication with every `/api/v1/*`
request.

In no-auth mode, that same probe returns `200`. The browser clears any stale
session token, omits bearer headers, and hides the lock action. This mode
removes only the bearer check. Every client that can reach the listener and
satisfy its request-boundary checks can read conversations and act with the
owner's authority. Bind to a trusted interface, enforce LAN or tailnet access
controls, and never expose it to an untrusted network.

The server validates the actual listener port and accepted local authority on
shell, health, and API requests. Mutations additionally require JSON and a
same-authority HTTP `Origin`; incompatible `Sec-Fetch-Site` requests fail
closed. These Host/origin checks defend browser request integrity and DNS
rebinding, but they are not authentication and do not provide transport
encryption. No-auth mode retains these checks, the media/body bounds, and the
static-file defenses unchanged.
Turn and upload bodies retain the 1 MiB product cap. Structured AskUser answers
have a dedicated 8 MiB cap so every module-sdk-valid answer remains
representable after JSON escaping.

### Non-loopback plaintext is an explicit risk opt-in

A non-loopback listener always requires:

```json
{
  "listen": { "host": "0.0.0.0", "port": 5050 },
  "allowInsecureHttp": true
}
```

Token mode additionally requires a token of at least 24 characters; no-auth
mode still requires the explicit opt-in. This remains plaintext HTTP:
credentials, when present, and conversation data are not transport-encrypted.
`allowInsecureHttp` only acknowledges that risk.

`allowedHosts` adds exact direct-listener hostnames or IP addresses, such as a
MagicDNS or LAN DNS name. Values contain no scheme, credentials, path, wildcard,
or port; they are normalized to lowercase/canonical IP form and deduplicated.
The configured listener authority remains implicitly accepted. Every request
must use the server's actual bound port, so an entry is
`"mickey-home.tail8a9beb.ts.net"`, not
`"mickey-home.tail8a9beb.ts.net:5050"`.

For loopback behind an HTTPS reverse proxy or Tailscale Serve, configure the
exact externally visible origin:

```json
{
  "listen": { "host": "127.0.0.1", "port": 5050 },
  "externalOrigins": [
    "https://mickey-home.tail8a9beb.ts.net:8444"
  ]
}
```

`externalOrigins` entries are canonical HTTPS origins. The port is part of the
origin and must be present when it is not `443`. They are honored only when the
TCP peer is loopback, so the field cannot turn a direct remote connection into
a trusted proxy connection. Conversely, `allowedHosts` does not configure TLS
or replace `externalOrigins` for a loopback proxy.

## Browser API

The browser-facing API is versioned separately from the agent operator wire:

| Endpoint | Purpose |
| --- | --- |
| `GET /healthz` | Unauthenticated process health after authority validation. |
| `GET /api/v1/bootstrap` | Discovered-agent and conversation summary after the selected access check. |
| `GET /api/v1/events` | Revisioned invalidation stream after the selected access check. |
| `POST /api/v1/threads` | Create a source-bound conversation for a live agent. |
| `GET /api/v1/threads/:id` | Read durable messages and current turn state. |
| `PATCH /api/v1/threads/:id` | Rename, archive, or restore one conversation. |
| `DELETE /api/v1/threads/:id` | Delete one archived conversation or dismiss one proactive import. |
| `POST /api/v1/threads/:id/turns` | Start a text turn and stream web-owned state snapshots as NDJSON. |
| `POST /api/v1/threads/:id/cancel` | Explicitly cancel that conversation's active turn. |
| `POST /api/v1/threads/:id/live-input` | Steer a web-owned active turn when advertised. |
| `POST /api/v1/threads/:id/ask` | Submit one canonical structured AskUser answer. |
| `GET /api/v1/threads/:id/replay` | Read authoritative replay for supported views and quotes. |
| `PATCH /api/v1/agents/:id` | Persist whether an agent stays visible while offline. |
| `GET /api/v1/agents/:id/config` | Read the endpoint's redacted config view. |
| `GET /api/v1/agents/:id/health` | Read bounded endpoint/Core health. |

The browser stream contains web thread projections, not raw operator frames.
The embedded React/assistant-ui client is built and packed as an installable
PWA. Token mode keeps its bearer token in `sessionStorage`; no-auth mode stores
none. Service-worker precaching excludes API and health responses.

## Durable state and turn ownership

The web service, not the browser response, owns an upstream turn. Closing or
reloading a tab stops delivery to that response but does not abort the agent
turn. The service continues committing assistant text and its terminal state;
the next admitted read sees the durable result. Explicit cancellation or
product shutdown is required to abort upstream work.

`dataDirectory` is created as `0700`. Its marker, singleton lease, and
`state.json` are current-user-owned `0600` regular files. Existing permissive,
wrong-owner, symlinked, multi-link, corrupt, or unknown-version paths fail
closed and are preserved rather than repaired or overwritten.

Each state mutation writes and fsyncs an exclusive same-directory temporary
file, atomically renames it to `state.json`, and fsyncs the directory. The
singleton lease uses an OS-released exclusive SQLite transaction; SQLite is
used only for the lease, not as the conversation store. If post-rename
durability becomes uncertain, the open store is poisoned until close/reopen so
a stale in-memory snapshot cannot overwrite the visible commit. Turns left
running by an unclean product stop become `interrupted` on the next exclusive
open.

For a coherent backup, stop the product and copy `state.json` together with
`.mono-agent-web-state`, preserving their modes. Restore those exact regular
files into an empty `0700` data directory before starting. There is no remote
reset or delete-all endpoint and no automatic retention policy in schema
version 3. A valid schema version 1 or 2 file is copied field-for-field into
version 3 and durably committed before reads are served.

## Current scope

The runnable web product provides owner-private registry discovery, durable
source-bound conversations, streamed turns, bounded uploads, replay-verified
assistant-ui quotes, structured AskUser forms, live input, runtime/model/effort
overrides, cancellation, response/proactive notifications, archived
conversation management, and pinned offline agents. Core advertises model
choices only from strictly validated configured routes. Explicit `cron` or
`webhook` provenance is retained through delivery metadata and rendered on the
new proactive conversation; it is never guessed from a conversation id.

Remote reset, multi-user accounts, TLS termination, and OS service management
remain outside this product. The foreground binary is independently supervised
from every agent.

## Related

- [Operator channel](/channels/tui/) — authenticated agent endpoint and current capability set.
- [Terminal operator](/observability/tui/) — independent pi-tui renderer.
- [architecture](/reference/architecture/) — product/config ownership and dependency direction.

---
title: "Standalone web operator"
description: "Run the authenticated browser product with separate config and owner-private durable conversations."
sidebar:
  order: 5
---

`@mono-agent/web` is a standalone browser operator for one or more locally
registered agents. It has its own config, listener, process, authentication,
and durable state. It is never selected by `mono-agent.config.json`, and
loading agent config never starts it.

The browser talks only to this product. The product discovers agents and uses
the strict `@mono-agent/operator` client, reducer, identity binding, and action
eligibility; it does not parse agent NDJSON or implement a second operator
state machine.

## Configure and run

Create a strict `web.config.json`:

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
    "../personal-agent/.mono-agent/trace-sources"
  ]
}
```

Paths resolve relative to the config file. `agentRegistries` must contain at
least one directory. Literal bearer values and unknown config fields are
rejected.

Start the foreground product:

```bash
MONO_AGENT_WEB_AUTH_TOKEN="replace-with-a-long-random-token" \
  mono-agent-web ./web.config.json
```

The default listener is `127.0.0.1:5050`. This package does not install an OS
service, configure Tailscale Serve, terminate TLS, or provide `start`/`restart`
lifecycle subcommands; a supervisor may run the foreground binary separately
from every agent.

<a id="security-boundary-trusted-network-no-login"></a>

## Browser authentication and request boundaries

The source config holds only `auth.token.$env`. The resolved token must contain
at least 16 characters. The browser shell prompts for it, retains it only in
that origin's `sessionStorage`, and sends bearer authentication with every
`/api/v1/*` request.

The server validates the actual listener port and accepted local authority on
shell, health, and API requests. Mutations additionally require JSON and a
same-authority HTTP `Origin`; incompatible `Sec-Fetch-Site` requests fail
closed. These Host/origin checks defend browser request integrity and DNS
rebinding, but they do not replace authentication or transport encryption.
Turn and upload bodies retain the 1 MiB product cap. Structured AskUser answers
have a dedicated 8 MiB cap so every module-sdk-valid answer remains
representable after JSON escaping.

### Non-loopback plaintext is an explicit risk opt-in

A non-loopback listener requires both a token of at least 24 characters and:

```json
{
  "listen": { "host": "0.0.0.0", "port": 5050 },
  "allowInsecureHttp": true
}
```

This remains plaintext HTTP: the bearer and conversation data are not
transport-encrypted. `allowInsecureHttp` only acknowledges that risk. Prefer a
loopback listener behind a correctly configured HTTPS reverse proxy or
Tailscale Serve, and do not expose the direct HTTP port to an untrusted network.

## Browser API

The browser-facing API is versioned separately from the agent operator wire:

| Endpoint | Purpose |
| --- | --- |
| `GET /healthz` | Unauthenticated process health after authority validation. |
| `GET /api/v1/bootstrap` | Authenticated discovered-agent and conversation summary. |
| `GET /api/v1/events` | Authenticated revisioned invalidation stream. |
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
PWA. It keeps its bearer token in `sessionStorage`; service-worker precaching
excludes API and health responses.

The console keeps a compact agent rail, searchable conversation navigation,
and a focused chat column on desktop; the first two surfaces become
keyboard-contained drawers on narrow screens. assistant-ui owns thread,
message, quote, composer, and selection behavior. Structured progress,
tool-call/result, and compaction events are grouped into one **Activity**
disclosure that stays open while a response is running and collapses when the
turn settles. Exact context telemetry and capability-gated model, effort, and
advanced runtime overrides stay in compact controls instead of occupying the
transcript.

## Durable state and turn ownership

The web service, not the browser response, owns an upstream turn. Closing or
reloading a tab stops delivery to that response but does not abort the agent
turn. The service continues committing assistant text and its terminal state;
the next authenticated read sees the durable result. Explicit cancellation or
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
- [v1 architecture](/reference/v1-architecture/) — product/config ownership and dependency direction.

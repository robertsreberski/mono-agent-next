---
title: "Webhook"
description: "Expose loopback-safe sync or async webhook endpoints, track request status, and configure prompts, notifications, model overrides, and watchdogs."
sidebar:
  order: 4
---

The webhook channel turns your agent into an HTTP endpoint: `POST` a JSON body with `text`, and the agent runs a turn. It is the zero-credential channel `mono-agent init` enables by default — a loopback smoke test you can `curl` immediately, and the integration point for automations, scripts, and other services. Coverage: **config** (`webhook` section), plus env overrides.

## Quick start

`init` writes a `webhook` block bound to loopback on a free port. Start the agent, then `POST` to the path:

```json
{
  "webhook": {
    "enabled": true,
    "host": "127.0.0.1",
    "port": 0,
    "path": "/webhook/invoke",
    "defaultMode": "sync"
  }
}
```

```bash
PORT=3000 # Replace 3000 with the port printed at startup.
curl -s "http://127.0.0.1:${PORT}/webhook/invoke" \
  -H 'content-type: application/json' \
  -d '{"text": "Summarize today’s standup notes."}'
```

The actual bound host/port (when `port: 0`) is printed in the start log. In **sync** mode the agent's answer is returned in the response body.

`mono-agent init` chooses and writes `enabled: true` for this starter endpoint.
That scaffold choice is distinct from the loader default: if `enabled` is
omitted from a hand-written config, the webhook channel remains off.

## Configuration

| Key | Type | Default | Notes |
|-----|------|---------|-------|
| `enabled` | boolean | `false` | Channel on/off. `mono-agent init` explicitly scaffolds `true`. |
| `host` | string | `127.0.0.1` | Bind address. Loopback-only unless `allowNonLoopback` is `true`. |
| `port` | integer | `0` | `0` picks a free port (printed at startup). `1`–`65535` to pin one. |
| `path` | string | `/webhook/invoke` | POST path for the default (single) endpoint. |
| `defaultMode` | `sync` \| `async` | `sync` | Response mode when a request does not override it. |
| `allowNonLoopback` | boolean | `false` | Required to bind a non-loopback `host`. See warning below. |
| `apiKey` | string | — | Optional static bearer token on loopback; required for a non-loopback bind. Prefer `MONO_AGENT_WEBHOOK_API_KEY` over committed JSON. Protects invoke and status routes. |
| `retentionMs` | integer | `300000` | How long completed/request statuses are retained (min 1, max 86_400_000). |
| `maxStoredRequests` | integer | `100` | Maximum status entries kept before oldest-first pruning (min 1, max 10_000). |
| `maxRunMs` | integer | `1200000` | Adapter-level wall-clock fallback per run (20 min). `endpoints[].maxRunMs` wins; `0` disables. Min 0, max 86_400_000. See [Run watchdog](#run-watchdog-a-wedged-run-is-aborted-not-left-to-starve). |
| `endpoints[].maxRunMs` | integer | inherited | Per-endpoint watchdog override. `0` disables only that endpoint; otherwise min 1, max 86_400_000. |
| `prompt` | string | — | Pre-instructions prepended to the request text (see [Prompts](#endpoint-prompts)). |
| `notify` | boolean | `false` | Deliver the successful final answer via native notification. |
| `notifyConversationId` | string | inferred if exactly one destination | Destination conversation id. Use exact `web:new` to create a new WEBHOOK-marked web conversation; web is never inferred. |
| `model` | string | `runtime.model` | Per-endpoint model override (e.g. `claude:claude-opus-4-8`). A request body `model` wins. See [Per-trigger model & effort](#per-trigger-model--effort). |
| `effort` | string | `runtime.effort` | Per-endpoint reasoning effort (`none`/`minimal`/`low`/`medium`/`high`/`xhigh`/`max`/`ultra`), subject to model support. Reasoning-capable `pi:*` maps `ultra` to LOW; Pi without reasoning uses OFF. Direct `codex:*` forwards `ultra` unchanged. Mono-agent rejects `ultra` on its Claude SDK route because the pinned SDK public contract ends at `max` (the SDK JavaScript itself forwards the value). The Claude CLI route passes `--effort ultra`, but both tested Claude Code binaries (SDK-bundled 2.1.206 and local 2.1.210) warn that it is unknown, ignore it, and use default effort. Direct OpenCode rejects explicit effort. Ranking above `max` only prevents keyword downgrade. A request body `effort` wins. |
| `endpoints` | array | — | Multiple named endpoints — see [Multiple endpoints](#multiple-endpoints). |
| `dir` | string | `webhook` | Folder of `*.md` endpoint files, resolved against the app working directory. |

:::caution
The webhook server binds to loopback by default. A non-loopback `host` (e.g. `0.0.0.0`) is rejected unless `allowNonLoopback: true` **and** a non-empty `apiKey` are both set. The built-in static bearer protects every invoke and status route, but public exposure still needs TLS, rate limiting, key rotation, and any provider-specific signature verification at a reverse proxy or integration boundary you control.
:::

When `apiKey` is set, callers send `Authorization: Bearer <key>`. Authentication runs before JSON body parsing, so missing, malformed, and incorrect bearer values all receive the same HTTP `401` without decoding the body; token comparison uses the shared timing-safe contract. The adapter removes `authorization`, `cookie`, `set-cookie`, `proxy-authorization`, and `x-api-key` from request metadata before the responder or artifacts can observe them. Leaving the key unset preserves the existing unauthenticated loopback behavior.

## Request and response

The request body is a JSON object. `text` is required; everything else is optional.

| Field | Required | Notes |
|-------|----------|-------|
| `text` | yes | The user message for this turn. Non-empty. |
| `mode` | no | `sync` or `async`, overriding the endpoint's mode for this request. |
| `conversationId` | no | Reuse to continue a thread. Defaults to a per-request id (`webhook:<requestId>`). |
| `model` | no | Per-request model override (`sdk:model` / `sdk:provider:model`). Wins over the endpoint's `model`. See [Per-trigger model & effort](#per-trigger-model--effort). |
| `effort` | no | Per-request reasoning effort (`none`/`minimal`/`low`/`medium`/`high`/`xhigh`/`max`/`ultra`), subject to model support. Reasoning-capable `pi:*` maps `ultra` to LOW; Pi without reasoning uses OFF. Direct `codex:*` forwards `ultra` unchanged. Mono-agent rejects `ultra` on its Claude SDK route because the pinned SDK public contract ends at `max` (the SDK JavaScript itself forwards the value). The Claude CLI route passes `--effort ultra`, but both tested Claude Code binaries (SDK-bundled 2.1.206 and local 2.1.210) warn that it is unknown, ignore it, and use default effort. Direct OpenCode rejects explicit effort. Ranking above `max` only prevents keyword downgrade. Wins over the endpoint's `effort`. |
| `metadata` | no | Arbitrary JSON passed through to the turn. |

### Sync mode

The request blocks until the turn finishes and returns the answer text in the body. Use it for short, interactive automations where you want the result inline.

### Async mode

The request returns immediately with **HTTP 202** and a `statusUrl`. Poll that URL until `status` is `succeeded` (text included), `failed`, or `cancelled`. Use it for long-running turns that would otherwise exceed an HTTP timeout.

```bash
# kick off
PORT=3000 # Replace 3000 with the port printed at startup.
curl -s "http://127.0.0.1:${PORT}/webhook/invoke" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer ${MONO_AGENT_WEBHOOK_API_KEY}" \
  -d '{"text": "Research and draft the weekly report.", "mode": "async"}'
# → 202 { "status": "accepted", "requestId": "...", "statusUrl": "/webhook/requests/..." }

# poll
REQUEST_ID='replace-with-request-id'
curl -s "http://127.0.0.1:${PORT}/webhook/requests/${REQUEST_ID}" \
  -H "authorization: Bearer ${MONO_AGENT_WEBHOOK_API_KEY}"
# → { "status": "succeeded", "text": "..." }
```

Async statuses are kept in memory subject to `retentionMs` and `maxStoredRequests`; a status URL polled after expiry returns `not_found`. If a turn is already running and the runtime cannot accept another, a request returns **HTTP 409** (`status: "busy"`) — that transient state is not stored or replayed via the status URL.

### HTTP status contract

| Route outcome | HTTP status | JSON `status` | Status-store behavior |
| --- | ---: | --- | --- |
| Async invocation admitted | `202` | `accepted` | A corresponding `running` entry is stored. |
| Stored status lookup | `200` | `running`, `succeeded`, `failed`, or `cancelled` | Retained until pruning or process restart. |
| Sync success | `200` | `succeeded` | Stored. |
| Sync cancellation | `499` | `cancelled` | Stored. |
| Sync failure | `500` | `failed` | Stored. |
| Same endpoint + conversation already active | `409` | `busy` | Never stored. |
| Unknown or expired request id | `404` | `not_found` | No entry exists. |
| Missing or invalid configured bearer | `401` | `unauthorized` | Never parsed or stored. |
| Invalid JSON/request shape | `400` | `failed` | Never admitted or stored. |
| Adapter stopping before admission | `503` | `failed` | Never admitted or stored. |

The status map is adapter-owned, bounded process memory; it is not durable and
is cleared by restart. Conversation history has a different owner. The adapter
forwards the exact `conversationId` to its responder, and the config-first
agent-app responder applies the host's durable history/session policy. A custom
responder may provide another policy or no persistence at all.

Harness response metadata is an external boundary. `metadata.summary` may include normal run status, model, usage, and failure information, but never the compiled `systemPrompt`. The harness removes it on success and early-failure paths, and the webhook adapter sanitizes untrusted custom responders again for sync responses, async storage/status reads, and result callbacks. Private local recorder artifacts may retain the prompt for operator inspection; it is not serialized onto webhook surfaces.

## Run watchdog: a wedged run is aborted, not left to starve

A hung run (a destination resolver, responder, or provider call that never settles) would otherwise hold its conversation slot forever. This matters most in **async** mode: with no client connection to disconnect, nothing else bounds the run. To prevent that, each webhook run is raced against a **20-minute watchdog** (`maxRunMs`, default `1200000`): a run that does not finish in time has its request signal aborted and its conversation slot reclaimed even if its in-flight work never settles. This brings webhook to parity with [cron's](/channels/cron/#run-watchdog-a-wedged-run-is-aborted-not-left-to-starve) `maxRunMs`.

Set `webhook.maxRunMs` to override the adapter default (min 0, max 86_400_000). Set `webhook.endpoints[].maxRunMs` to give one endpoint its own bound. Precedence is **endpoint `maxRunMs` > adapter `maxRunMs` > 20-minute app default**; because the lookup is nullish, an endpoint value of `0` explicitly disables its watchdog even when the adapter fallback is positive. Endpoints without an override continue to use the adapter fallback. A run whose responder resolves **after** the abort is classified `cancelled` rather than `succeeded` — see [Run artifacts & traces](/observability/artifacts-and-traces/).

Programmatic destination resolvers receive the request's `AbortSignal`, and their promise is raced against it independently of the watchdog. A sync client disconnect or adapter stop therefore reclaims a slot that is still resolving even when `maxRunMs` is disabled and resolver code ignores the signal; later settlement cannot start a responder or emit another result.

## Proactive delivery

For a webhook endpoint that produces a user-facing result, set `notify: true` and optionally `notifyConversationId`. The agent's successful, non-empty **final answer is delivered verbatim** to Telegram, Slack, or the web console — no second LLM turn — and recorded into that destination's history, so a user's reply resumes with it in context. This works for both **sync** and **async** endpoints: sync mode still returns the answer in the HTTP response, and `notify: true` *additionally* delivers it to the destination (async, via the post-run hook). Delivery is best-effort and does not change the sync HTTP response or the async stored status if it is skipped or fails.

The operator just writes the endpoint prompt; on a notify turn the harness auto-injects guidance telling the agent its final reply is delivered as-is. To send nothing, the agent produces an **empty final answer** or replies with exactly the reserved sentinel `NOTHING_TO_REPORT` (matched trimmed, case-insensitive).

**Destination resolution.** If `notifyConversationId` is set, it is used (`telegram:42`, `slack:C123`, `slack:C123:1718.99` for a Slack thread, or the exact value `web:new`). `web:new` creates a separate assistant-only conversation for every distinct successful invocation, marked **WEBHOOK** in the sidebar and header. It is explicit-only and never participates in destination inference. If `notifyConversationId` is omitted, the app infers the destination **only when exactly one** Telegram/Slack notify-capable candidate exists (from seen conversations plus the adapter allowlist); with 0 or 2+ candidates it skips delivery with a warning rather than guessing. Artifact-derived candidates are cached for 30 seconds after each scan completes. An artifact committed under a Telegram/Slack conversation id invalidates the cache immediately; runs using the default synthetic `cron:`/`webhook:` ids do not. Other artifact changes are picked up after cache expiry and the next scan completes. The allowlist is the destination boundary for Telegram/Slack. Web delivery makes one attempt against the running local console and has no retry queue or outbox.

Notifying multiple or other conversations from one endpoint is not a built-in: compose it from a skill or from multiple endpoints, each with its own `notifyConversationId`.

## Per-trigger model & effort

An endpoint can run on a different model or reasoning effort than the agent's default, set per-endpoint in config **and/or** per-request in the body. This powers a **delegate** pattern: the host "deploys" a sub-agent by POSTing to a webhook that runs a heavier task (e.g. deep research) on a more powerful model.

```bash
curl -X POST "$URL/delegate" -H 'content-type: application/json' \
  -d '{"text": "Deep-research X and write a brief.", "model": "claude:claude-opus-4-8", "effort": "high"}'
```

Precedence is **request body > endpoint config > agent default** (`runtime.model` / `runtime.effort`). The override becomes that turn's **primary** model; configured canonical `runtime.fallbacks` (or legacy backups) remain. Under `runtime.routeSafety: "uniform"`, an incompatible safety-family override is rejected. Explicit `per-route-native` allows it only with the route's documented native contract; required capabilities are never silently removed. Static invalid values fail `mono-agent validate`; dynamic invalid values are warned and ignored, so the request still runs on the safe default model. Effort must be one of `none`/`minimal`/`low`/`medium`/`high`/`xhigh`/`max`/`ultra` and supported by the selected model. Reasoning-capable `pi:*` maps `ultra` to LOW; Pi without reasoning uses OFF. Direct `codex:*` forwards `ultra` unchanged. Mono-agent rejects `ultra` on its Claude SDK route because the pinned SDK public contract ends at `max` (the SDK JavaScript itself forwards the value). The Claude CLI route passes `--effort ultra`, but both tested Claude Code binaries (SDK-bundled 2.1.206 and local 2.1.210) warn that it is unknown, ignore it, and use default effort. Direct OpenCode rejects explicit effort. Ranking above `max` only prevents keyword downgrade.

The request body may always *request* an override, but the host applies it only
when it preserves the configured runtime/sandbox boundary; an incompatible value
is warned and ignored. Its remaining model-selection authority rests on the
webhook's loopback-only default (`allowNonLoopback: false`). If you expose the
endpoint beyond loopback, configure `apiKey` (required) and put the service
behind TLS plus the reverse-proxy controls appropriate for the integration.

A model-override request runs **ephemerally**: it does not resume or persist a shared continuous session, so the delegated model never mixes into a conversation's session lineage (the per-request `conversationId` default already keeps deploys separate). Overrides to configured local providers are supported: mono-agent recomputes the target provider's endpoint and capabilities. An unconfigured or invalid local target clears the inherited endpoint block and is rejected rather than accidentally using the host provider. Execution mode is preserved from the host config when the override model supports it, otherwise the model's default mode is used. An `effort`-only request keeps the same model chain; it is ignored if that chain contains direct OpenCode.

## Multiple endpoints

You can serve several named endpoints on the **one** shared host/port, each with its own path, mode, and optional prompt. Define them inline under `webhook.endpoints[]`:

```json
{
  "webhook": {
    "enabled": true,
    "port": 8787,
    "defaultMode": "sync",
    "maxRunMs": 1200000,
    "endpoints": [
      {
        "name": "triage",
        "path": "/hooks/triage",
        "mode": "async",
        "maxRunMs": 3600000,
        "prompt": "You are triaging an inbound support ticket. Classify and summarize.",
        "notify": true,
        "notifyConversationId": "slack:C012345"
      },
      {
        "name": "echo",
        "path": "/hooks/echo",
        "enabled": true,
        "maxRunMs": 0
      }
    ]
  }
}
```

Each endpoint needs a **unique `name` and a unique `path`**; a duplicate of either (across inline config and folder files) is a hard configuration error. `mode` defaults to `defaultMode`, `enabled` defaults to `true`, and an omitted `maxRunMs` inherits the adapter-level value. Endpoint `maxRunMs: 0` disables the watchdog for only that endpoint.

### Endpoint files (`*.md`)

Instead of (or alongside) inline config, author one `*.md` file per endpoint in `webhook.dir` (default `webhook/`). The YAML frontmatter holds routing metadata and the markdown body becomes the endpoint's `prompt`:

```markdown
---
name: triage
path: /hooks/triage
mode: async
enabled: true
maxRunMs: 3600000
notify: true
notifyConversationId: slack:C012345
---
You are triaging an inbound support ticket. Classify it and summarize the next action.
```

`path` is required in frontmatter; `name` defaults to the filename stem, `mode` to `defaultMode`, `enabled` to `true`, and `notify` to `false`. Optional `maxRunMs` follows the same `0`–`86400000` endpoint semantics as inline config. Unlike [cron](/channels/cron/) jobs, the body may be empty (an endpoint with no prompt). Files are loaded in sorted filename order. This mirrors how cron jobs can be authored as `cron/*.md` files.

## Endpoint prompts

A per-endpoint `prompt` (inline, or the body of an `*.md` file) is **prepended to the incoming request `text`** before the turn runs — the same role a cron job's prompt plays. This lets one HTTP caller send only data while the endpoint supplies the standing instructions. Callers cannot see or override the prompt.

## Environment variables

Every key has a `MONO_AGENT_WEBHOOK_*` override, which takes precedence over the JSON config:

| Env var | Maps to |
|---------|---------|
| `MONO_AGENT_WEBHOOK_ENABLED` | `webhook.enabled` |
| `MONO_AGENT_WEBHOOK_HOST` | `webhook.host` |
| `MONO_AGENT_WEBHOOK_PORT` | `webhook.port` |
| `MONO_AGENT_WEBHOOK_PATH` | `webhook.path` |
| `MONO_AGENT_WEBHOOK_DEFAULT_MODE` | `webhook.defaultMode` |
| `MONO_AGENT_WEBHOOK_ALLOW_NON_LOOPBACK` | `webhook.allowNonLoopback` |
| `MONO_AGENT_WEBHOOK_API_KEY` | `webhook.apiKey` |
| `MONO_AGENT_WEBHOOK_RETENTION_MS` | `webhook.retentionMs` |
| `MONO_AGENT_WEBHOOK_MAX_STORED_REQUESTS` | `webhook.maxStoredRequests` |
| `MONO_AGENT_WEBHOOK_MAX_RUN_MS` | `webhook.maxRunMs` |
| `MONO_AGENT_WEBHOOK_PROMPT` | `webhook.prompt` |
| `MONO_AGENT_WEBHOOK_NOTIFY` | `webhook.notify` |
| `MONO_AGENT_WEBHOOK_NOTIFY_CONVERSATION_ID` | `webhook.notifyConversationId` |
| `MONO_AGENT_WEBHOOK_MODEL` | `webhook.model` |
| `MONO_AGENT_WEBHOOK_EFFORT` | `webhook.effort` |
| `MONO_AGENT_WEBHOOK_DIR` | `webhook.dir` |
| `MONO_AGENT_WEBHOOK_ENDPOINTS_JSON` | `webhook.endpoints` (JSON array string) |

See [Environment variables](/config/env-vars/) for precedence rules.

## Related

- [Webhook automation: sync and async](/playbooks/webhook-automation-sync-async/) — end-to-end recipe.
- [Cron](/channels/cron/) — scheduled turns; shares the `*.md` authoring pattern and the `prompt` concept.
- [Delivery and send tools](/channels/delivery-and-send-tools/) — how answers are returned and proactively delivered.
- [Channels overview](/channels/) — all channels and the allowlist model.
- [Write your own channel adapter](/programmatic/custom-channels/) — build your own transport.

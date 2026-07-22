---
title: "Durable continuations"
description: "Let trusted MCP services complete long-running work and deliver one later answer to the originating conversation."
sidebar:
  order: 4
---

Durable continuations let a trusted MCP service finish work after the originating agent run has returned and deliver one later answer to the original channel conversation. The host, rather than the model, binds the reply destination, persists delivery state, runs one tool-free synthesis turn, and records a receipt only after native delivery succeeds.

Use continuations for delegated work whose lifetime is longer than one MCP call. They are different from native cron/webhook notification: native notification delivers the producing run's final text, while an interactive continuation accepts a later external result and synthesizes from the immutable origin snapshot prepared and bound by the originating run.

## Configure a trusted continuation server

Select MCP servers explicitly with `tools.continuationServers`. A selected server must already exist in the MCP configuration named by `tools.mcpConfigPath` and must use stdio or loopback streamable HTTP. Remote HTTP, SSE, and unlisted servers fail validation and do not receive continuation authority.

```json
{
  "tools": {
    "mcpConfigPath": "./mcp.json",
    "continuationServers": ["work-control"]
  },
  "continuations": {
    "enabled": true,
    "host": "127.0.0.1",
    "port": 4319,
    "stateDir": ".mono-agent/continuations",
    "limits": {
      "maxActiveRecords": 10000,
      "maxActivePerOrigin": 500,
      "maxConcurrent": 16,
      "synthesisTimeoutMs": 600000,
      "deliveryTimeoutMs": 120000,
      "operatorPageSize": 100
    },
    "retention": {
      "terminalMaxRecords": 50000,
      "terminalMaxAgeMs": 31536000000,
      "capturedTextMaxRecords": 1000,
      "capturedTextMaxAgeMs": 2592000000
    },
    "namedRoutes": {
      "daily-attention": {
        "mode": "notify_if_actionable",
        "conversationId": "slack:C_EXAMPLE:T_EXAMPLE"
      },
      "verification": {
        "mode": "capture",
        "conversationId": "slack:C_EXAMPLE:T_EXAMPLE"
      },
      "background-index": {
        "mode": "silent"
      }
    },
    "detachedServices": [
      {
        "name": "work-control",
        "tokenEnv": "WORK_CONTROL_CONTINUATION_TOKEN"
      }
    ]
  }
}
```

`continuations.host` is loopback-only. `continuations.port` is a fixed port from 1 through 65535 and defaults to `4319`; ephemeral port `0` is rejected because persisted result/status URLs and detached operator access must survive restarts. `stateDir` defaults to `.mono-agent/continuations`. Active admission defaults to 10,000 records globally and 500 from one immutable run/detached-route origin. Processing uses at most 16 independent workers, with 10-minute synthesis and 2-minute delivery timeouts. Operator pages default to at most 100 records. Retention defaults to 50,000 terminal tombstones for 365 days and 1,000 captured answers for 30 days. A detached-service bearer is read from the named environment variable, must contain at least 16 characters, and is never stored in the JSON config.

Named routes are host-owned policies, not destinations supplied by a caller:

| Mode | Behavior | `conversationId` |
| --- | --- | --- |
| `reply` | Reply to the physical conversation captured from an interactive request. | Not a named-route mode; the host binds it from the request. |
| `notify_if_actionable` | Synthesize and deliver only when the submitted payload is actionable. | Required for a named route. |
| `capture` | Synthesize and retain text for verification without posting to a channel. | Required as synthesis context; no channel post occurs. |
| `silent` | Mark accepted work delivered without synthesis or channel delivery. | Forbidden. |

The service starts when the `continuations` block is present or at least one `tools.continuationServers` entry is configured. When only `tools.continuationServers` is present, both the service and operator CLI use the documented defaults: `127.0.0.1:4319` and `.mono-agent/continuations`. Setting `continuations.enabled: false` disables it, including request-bound claims.

## Trusted request binding

Channel drivers attach a host-only `replyTo: { conversationId }` to `AgentRequestBase`. This physical route is separate from `conversationId`, which may include a daily rollover bucket used for history and provider sessions. `replyTo` and continuation controls are not included in model prompts or tool arguments. The exact origin id is immutable: a continuation synthesized after midnight keeps an explicit prior-day `#YYYY-MM-DD` bucket instead of being silently moved into the current day.

For each selected MCP server, mono-agent issues a short-lived claim capability bound to the run, server name, exact origin history, physical reply route, and delivery mode. After all MCP option layers are merged, the host overwrites these reserved values.

For stdio:

- `MONO_AGENT_CONTINUATION_CLAIM_URL`
- `MONO_AGENT_CONTINUATION_CLAIM_TOKEN`
- `MONO_AGENT_CONTINUATION_CLAIM_FINGERPRINT`
- `MONO_AGENT_CONTINUATION_CLAIM_MODE`

For loopback HTTP:

- `x-mono-agent-continuation-claim-url`
- `x-mono-agent-continuation-claim-token`
- `x-mono-agent-continuation-claim-fingerprint`
- `x-mono-agent-continuation-claim-mode`

Configured values with those names are discarded. The service must claim the continuation during that MCP request. When the tool clients settle, the host first closes the capability to new claims and drains any already-admitted claim mutation before deciding whether origin context is required. A slow request that has not completed claim admission cannot race capability release and create a late, permanently pending continuation. A model-provided channel ID, callback URL, or copied request header has no routing authority.

## Claim, result, and status protocol

The selected service claims before it reports that asynchronous work was accepted:

```http
POST /v1/continuations/claim
Authorization: Bearer <request-bound claim token>
Content-Type: application/json

{
  "taskKey": "stable-task-key",
  "taskHash": "sha256-of-immutable-task",
  "deadline": "2030-01-02T03:04:05.000Z"
}
```

The response contains `continuationId`, `resultUrl`, `statusUrl`, an opaque result `token`, `expiresAt`, and the bound `fingerprint`. Repeating the same claim is idempotent; reusing its identity with a different task hash, deadline, or binding returns a conflict. Deadlines must be in the future and no more than 30 days away. Terminal claim/result idempotency lasts for the configured tombstone retention horizon, so that horizon should exceed the longest producer retry or reconciliation window.

### Origin settlement lifecycle

Interactive claims use a host-owned prepare/commit protocol. The producer does not control these steps:

1. **Prepare the completed turn.** If at least one active claim remains after the claim capability is closed and drained, the harness builds one immutable origin snapshot from the exact conversation bucket. It contains whole retained history turns and ends with the completed origin user/assistant pair. The snapshot is capped at 64 messages, 64 KiB of content per message, and 256 KiB total. Size pressure removes whole oldest turns; it never truncates message content or separates a user/assistant pair.
2. **Finalize before origin commit.** The host writes the snapshot as a content-addressed owner-only blob and binds its digest to each active claim. This happens before provider-session, conversation-history, and successful-run commit. If validation, storage, or the 256 MiB aggregate blob quota fails, the origin turn fails without publishing a success whose callback context was never secured.
3. **Activate after origin commit.** Only after the origin turn's normal durable commit succeeds does the host publish a group activation marker. That marker is the semantic commit point for every active claim from the same origin run and history boundary; restart recovery finishes any interrupted per-record materialization. A result received early remains deferred while the snapshot is prepared and activated. This rule applies to `silent` as well as model-backed modes.
4. **Abandon on pre-commit failure.** If the origin run is cancelled or fails before commit, the host marks still-pending claims abandoned. They do not wait indefinitely for mutable history. Modes that would normally synthesize use the deterministic origin-context fallback described below.

The status response exposes the origin context as `pending`, `pinned`, `abandoned`, `detached_latest`, `legacy_missing`, or `scrubbed`. `pending` is preparation state, not permission to synthesize from whatever history happens to exist later.

When work finishes, submit one immutable JSON result:

```http
PUT <resultUrl>
Authorization: Bearer <result token>
Content-Type: application/json

{
  "idempotencyKey": "stable-result-key",
  "payloadHash": "sha256-of-the-JSON-payload",
  "payload": { "summary": "Completed result" }
}
```

`POST` is also accepted. The result body is capped at 256 KiB. Repeating an identical submission is safe; changing the idempotency key or payload after acceptance returns a conflict. `GET <statusUrl>` with the same result token returns the continuation state, attempt counts, bounded last error, and terminal receipt when present.

### Detached claims

A deterministic service that did not originate inside an interactive run can claim only a configured named route:

```http
POST /v1/continuations/detached/claim
Authorization: Bearer <detached-service token>
X-Mono-Agent-Service-Name: work-control
Content-Type: application/json

{
  "route": "daily-attention",
  "taskKey": "stable-task-key",
  "taskHash": "sha256-of-immutable-task",
  "deadline": "2030-01-02T03:04:05.000Z"
}
```

The service name must match `continuations.detachedServices`, and the route must match `continuations.namedRoutes`. The request cannot name or override a channel destination.

## Synthesis and delivery

An accepted payload moves through a durable lifecycle independent of the original run status:

```text
claimed -> result_received -> synthesizing -> ready_to_deliver -> delivered
                                      \-> delivery_retry ------/
```

Terminal alternatives are `delivery_unknown`, `expired`, `cancelled`, and `dead_lettered`.

For an interactive `reply`, `notify_if_actionable`, or `capture`, mono-agent passes the pinned snapshot directly to the synthesis turn. It does not reconstruct the origin from mutable latest history and it preserves the exact rollover bucket captured by the origin run. The callback payload is framed as untrusted data. The synthesis request has `toolsDisabled: true` and `deferHistoryCommit: true`; it cannot call MCP, built-in, or adapter send tools. A detached named route deliberately has policy `detached_latest` and uses the latest bounded durable history for its configured conversation because it has no interactive origin snapshot.

If an interactive snapshot is absent, abandoned, unreadable, corrupt, or fails its content-digest check while its immutable record binding remains authentic, mono-agent does not call the synthesis model and does not keep retrying for history that cannot reappear. It durably prepares the fixed answer `The background task finished, but I could not safely restore the original conversation context. Please ask me to check the result again.`, records `completionKind: "origin_context_unavailable"`, and continues through the normal capture or delivery path. Records migrated from older continuation formats that had a history boundary but no immutable snapshot are explicitly classified as `legacy_missing` and take the same zero-model path. A failed binding HMAC instead proves that immutable claim metadata was altered; that record is dead-lettered and nothing is delivered.

The generated text is persisted before channel delivery. `reply` uses native verbatim delivery to the bound channel/thread with a stable delivery key. A confirmed native post returns a receipt containing the delivery time and, when supplied by the adapter, channel and delivery IDs. The receipt also carries `historyRecorded`; if the post succeeded but the later history append failed, it remains `delivered` with `historyRecorded: false` and a bounded `historyErrorCode`. That state is health-degraded but is never retried, because reposting a confirmed message would duplicate user-visible output. `capture` retains the synthesized text without posting; `silent` skips synthesis; a non-actionable `notify_if_actionable` result records a `suppressed` receipt.

Synthesis is at most once. A thrown, timed-out, or interrupted synthesis is dead-lettered rather than repeated because the model outcome may be ambiguous. Workers run concurrently within the configured bound, so one unresponsive provider cannot hold the service's other continuations or shutdown hostage. After synthesized text is durably persisted, retryable native delivery uses bounded exponential backoff and at most 20 attempts. Every chunk of a multi-message answer must receive a native receipt; a partial answer is `delivery_unknown`, never a successful delivery. A permanent adapter refusal is dead-lettered. If a process stops after native posting has begun and the outcome cannot be proved, the continuation becomes `delivery_unknown`; mono-agent does not blindly post it again.

## Health and recovery

Use the authenticated local operator client to inspect and recover continuations. It derives its restart-stable capability from the owner-only service secret and never accepts a destination:

```sh
mono-agent continuations health
mono-agent continuations list
mono-agent continuations list --limit 50 --cursor OPAQUE_NEXT_CURSOR
mono-agent continuations list --json
mono-agent continuations retry CONTINUATION_ID
mono-agent continuations cancel CONTINUATION_ID
mono-agent continuations resolve CONTINUATION_ID delivered DELIVERY_ID
mono-agent continuations resolve CONTINUATION_ID not-delivered
mono-agent continuations resolve CONTINUATION_ID dead-lettered
```

The CLI connects to the configured fixed loopback host and port, or to `127.0.0.1:4319` when the `continuations` block is omitted. Health is:

- `healthy` when no continuation needs attention;
- `degraded` while work is pending, an item expired, or a confirmed delivery could not be appended to conversation history;
- `unhealthy` when an item is dead-lettered or has an unknown delivery outcome.

`delivery_unknown` must be resolved explicitly as delivered, not delivered, or dead-lettered. Resolving it as delivered invokes a history-only commit that cannot post to the channel; a failed history commit remains explicitly health-degraded. A normal retry refuses it unless the caller deliberately opts into an unsafe retry after external verification. Startup recovery resumes safe pre-send work, but converts interrupted synthesis or delivery into a non-replayed terminal state when repeating it could duplicate user-visible output.

The authenticated `GET /v1/operator/continuations` endpoint and CLI use keyset pagination. `limit` may be lowered from the configured `operatorPageSize`; when more records remain, human output prints the exact next CLI command and JSON returns the opaque `nextCursor`. Pass that value with `--cursor` (or the HTTP `cursor` query) on the next request. Oversized limits and invalid cursors fail closed.

The programmatic app handle exposes `continuationHealth()`, `listContinuations()`, `capturedContinuationText()`, `retryContinuation()`, `cancelContinuation()`, and `resolveContinuationDelivery()` for embedded hosts. `capturedContinuationText(id)` returns text only for a delivered `capture` continuation; the CLI deliberately does not print captured synthesis text:

```ts
const health = await app.continuationHealth?.();
const items = await app.listContinuations?.();
const captured = await app.capturedContinuationText?.(continuationId);

await app.retryContinuation?.(continuationId);
await app.cancelContinuation?.(continuationId);
await app.resolveContinuationDelivery?.(continuationId, {
  kind: "delivered",
  deliveryId: "externally-verified-receipt",
});
// Alternatives after inspection: { kind: "not_delivered" } or
// { kind: "dead_lettered" }.
```

`retryContinuation(id, { allowUnknown: true })` exists for an operator who has independently proved that replay is safe. It is not a substitute for resolving an ambiguous channel outcome. `cancelContinuation` is idempotent only for an already-cancelled item; other terminal states are preserved.

The owner-only store lives in `stateDir` and reports format `per-record-v3`. State, record, origin-blob, and activation-marker directories are mode `0700`; per-record files, bounded write-ahead transactions, manifests, blobs, ownership database, and the persistent token-derivation secret are mode `0600`. Symlinks, extra hard links, wrong ownership, permissive modes, non-regular files, and descriptor identity changes fail closed. Each record is atomically replaced and fsynced, interrupted transactions replay idempotently, transaction/manifest generation identifiers are capped at 256 bytes, and manifests are capped at 1 MiB. Process-lifetime ownership uses an OS-released SQLite exclusive lock rather than a stale pathname lock. Snapshot blobs are content-addressed, digest- and HMAC-bound to their immutable claim, and swept after the last durable reference disappears. Terminal payloads are compacted into bounded idempotency tombstones; captured text has a separate bounded retention window. Continuations are not run artifacts and are not removed by artifact retention.

Opening v3 state migrates only when v1/v2 evidence exists. A brand-new empty v3 store therefore has no `records-v2` directory. Before legacy data is materialized as v3, or before the first native v3 record or activation marker becomes durable, mono-agent creates `records-v2`, fsyncs its parent, and fsyncs the explicit rollback guard. Migration completion is a separate durable phase: the exact configured retention result is size-preflighted on a clone, then normalized legacy records and a guard-required v3 manifest are committed before retention or origin-context activation is applied as ordinary v3 work. The manifest closes this rollback window only after the complete migration or native v3 commit; a crash after the guard or between bounded migration batches repeats the retained semantic merge. An incomplete record or activation-marker temporary is cleanup-only; validation distinguishes it from committed evidence. The v1 monolith is read through an identity-stable, owner-only descriptor with a 256 MiB aggregate ceiling, and every normalized legacy record must fit the v3 2 MiB per-record limit before migration completion. Unsafe or oversized legacy state fails closed before the v3 fence is published; retention is never used to make an oversized migration appear safe. This permits one clean rollback to the v0.10 `records-v2` format while the v3 store remains empty: the next current-runtime open migrates that state idempotently and installs the guard. Once the guard exists, a 0.10 or older runtime fails closed instead of reopening a stale mutable v2 view. This does not make arbitrary downgrades between v3 builds safe. Do not remove the guard or run an older mono-agent against a continuation state directory with v3 records; restore the complete pre-upgrade state directory if a runtime rollback is required.

## Security and compatibility

- Continuation HTTP surfaces bind only to `localhost`, `127.0.0.1`, or `::1`. Selecting a remote HTTP or SSE MCP server fails before provider startup.
- Claim, result, detached-service, and operator credentials are separate capabilities. They are never model-visible and must not be logged or placed in task/result schemas.
- Channel allowlists are checked again at synthesis and delivery. A revoked destination fails; there is no fallback to another DM, channel, or thread.
- `tools.continuationServers` is independent of `tools.mcpRequestContextServers`. Existing stdio request context and progress behavior is unchanged.
- A2A `contextId` remains task/session correlation, not a delivery route. A2A payloads do not carry continuation credentials.
- Native cron/webhook `notify: true` remains the correct path for delivering the producing run's final answer. Existing webhook endpoints may still use an explicit operator-configured `notifyConversationId`; models should not copy conversation IDs to construct asynchronous callbacks.
- Existing MCP servers receive no continuation authority until explicitly selected. Existing run status remains succeeded or failed independently of any later continuation state.
- Upgraded legacy continuation records are retained for audit and idempotency, but interactive records without a v3 origin snapshot cannot recover historical context retroactively. They use the deterministic zero-model fallback rather than mutable latest history.

## Related pages

- [MCP servers](/tools/mcp/) — declaring servers and trusted request context.
- [Delivery and send tools](/channels/delivery-and-send-tools/) — native notify, channel delivery, and adapter send tools.
- [Context assembly](/context/assembly/) — why host-only reply targets never enter prompts.
- [Slack](/channels/slack/) — native thread delivery and adapter allowlists.

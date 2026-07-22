---
title: "A2A consumer"
description: "Discover remote Agent Cards and invoke A2A agents through the plugin's programmatic consumer APIs."
sidebar:
  order: 4
---

This page covers calling a remote [A2A](https://a2a-protocol.org/) agent from your own mono-agent: discovering its Agent Card, sending messages, and wiring a remote agent in as a responder. The settings live under the A2A plugin entry's `config.consumer`, but **invocation is code-only** — there is no channel that auto-dials remote agents for you. For the inbound (provider) side that exposes *your* agent over A2A, see [A2A channel](/channels/a2a/).

Coverage: **config + code**. Config holds the connection settings; you call `createA2AConsumerResponder` (or the lower-level helpers) yourself, typically from a multi-agent host. See [Multi-agent](/programmatic/multi-agent/) and [Composition](/programmatic/composition/).

## When to use this

Use the consumer when your agent needs to delegate to another A2A-speaking agent — for example a multi-agent host that routes some requests to a specialized remote agent. The remote agent can be another mono-agent running the A2A provider, or any third-party A2A server.

## Config: plugin `config.consumer`

The A2A plugin entry's `config.consumer` block stores the remote endpoint(s), auth, and timeout. It does not start anything on its own; your code reads it and constructs a responder.

Put the remote bearer token in `.env` as
`MONO_AGENT_A2A_CONSUMER_BEARER_TOKEN`; the source-config example omits it.

```json
{
  "channels": {
    "plugins": [
      {
        "package": "@mono-agent/a2a-adapter",
        "id": "a2a",
        "config": {
          "consumer": {
            "remoteAgentUrls": ["http://127.0.0.1:4202"],
            "defaultRemoteAgentUrl": "http://127.0.0.1:4202",
            "timeoutMs": 30000
          }
        }
      }
    ]
  }
}
```

| Key | Type | Purpose |
| --- | --- | --- |
| `remoteAgentUrls` | `string[]` | Allowed/known remote agent base URLs. Use this set to drive per-request selection. |
| `defaultRemoteAgentUrl` | `string` | The remote URL to dial when a request does not name one. |
| `bearerToken` | `string` | Bearer token sent on discovery and `sendMessage` calls when the remote requires auth. Keep it out of committed config and inject it with `MONO_AGENT_A2A_CONSUMER_BEARER_TOKEN`. |
| `timeoutMs` | `number` | Per-request timeout in milliseconds. |

Keep tokens out of committed config — reference them through environment variables and your config loader. See [Environment variables](/config/env-vars/) for the `MONO_AGENT_*` conventions.

:::caution
There is no auto-wired A2A consumer channel. If you set plugin `config.consumer` but never call `createA2AConsumerResponder` (or `sendA2AMessage`), nothing connects to the remote agent.
:::

## `createA2AConsumerResponder`

`createA2AConsumerResponder` returns a standard `AgentResponder`, so a remote A2A agent plugs into the same composition machinery as any local agent. It is **lazy**: the Agent Card discovery and client creation happen on the first `respond()` call, then the connected client is reused for subsequent calls.

```ts
import { createA2AConsumerResponder } from "@mono-agent/a2a-adapter";

const responder = createA2AConsumerResponder({
  agentUrl: "http://127.0.0.1:4202",
  bearerToken: process.env.MONO_AGENT_A2A_CONSUMER_BEARER_TOKEN,
  timeoutMs: 30_000,
});

// Later, on a turn:
const response = await responder.respond(request, stream);
```

Options:

| Option | Type | Notes |
| --- | --- | --- |
| `agentUrl` | `string` | Required. Base URL of the remote agent; its Agent Card is fetched from the well-known card path. |
| `bearerToken` | `string?` | Optional bearer token attached to all outbound requests. |
| `timeoutMs` | `number?` | Optional per-request timeout. |
| `streamRemote` | `boolean?` | When `true` *and* the remote Agent Card advertises streaming, the response is streamed; otherwise a single message is sent and the text appended once. |
| `idempotencyKeyForRequest` | `(request) => string \| undefined` | Optional resolver for an existing stable logical-dispatch key. No key is invented when it returns `undefined`. |

On each `respond()`, the responder maps the incoming request onto the remote `sendMessage` call: `request.text` becomes the message text, `request.conversationId` becomes the remote `contextId`, and `request.abortSignal` is forwarded so cancellation propagates to the remote agent.

## Stable logical dispatch identity

For paid or otherwise non-repeatable work, pass one stable key for the logical
dispatch, not a newly generated key for each HTTP attempt:

```ts
const response = await sendA2AMessage({
  agentUrl,
  text: canonicalPayload,
  contextId,
  returnImmediately: true,
  idempotencyKey: delegationId,
});
```

Do not use `taskId` as an initial identity. A2A task ids are provider-created,
and the pinned SDK rejects unknown initial task ids. The consumer discovers the
Agent Card first and refuses a keyed call with `idempotency_unsupported` unless
the provider advertises the mono-agent v1 extension. Long-lived consumers
re-check the live card before every keyed POST; mono-agent providers without
durable state reject a stale reserved envelope instead of ignoring it. The
reserved wire envelope is paired with the standard `A2A-Extensions` request
parameter, activated by the provider, and stripped before the responder/model.

The same namespace/key and execution payload rejoin one task. Each caller still
chooses its own response projection: `returnImmediately: true` gets the accepted
or current task, while `false` waits for that same task's terminal result;
`historyLength` applies only to that caller's returned clone. A changed execution
payload returns `idempotency_conflict`.

`sendA2AMessage` / `A2AConsumer.sendMessage` expose `returnImmediately`,
`historyLength`, and `stream` as caller-specific projections. Keyed streaming
returns one authoritative task/message rather than transient deltas, because
those deltas cannot be reconstructed from the durable terminal receipt.

## Durable dispatch lifecycle

Use `dispatchMessage` when the caller must admit long-running work now and
reconcile its terminal state later. It requires an `idempotencyKey` and owns the
response projection: callers cannot set `returnImmediately` or `stream`.

```ts
import { createA2AConsumer } from "@mono-agent/a2a-adapter";

const consumer = await createA2AConsumer({ agentUrl });
const dispatch = await consumer.dispatchMessage({
  text: canonicalPayload,
  contextId,
  idempotencyKey: delegationId,
  timeoutMs: 10_000, // admission only
});

console.log(dispatch.current.metadata.a2a.taskId);

const outcome = await dispatch.observeTerminal({
  timeoutMs: 120_000, // this observation only
  signal: observerSignal,
});

if (outcome.status === "completed") {
  console.log(outcome.response.text);
} else {
  console.warn(outcome.status, outcome.error.code);
}
```

`dispatch.current` is the latest authoritative snapshot seen through that
handle. `observeTerminal()` sends the identical canonical payload and key with
the blocking projection, so a durable mono-agent provider joins the admitted
task rather than invoking the responder again. Concurrent observers and later
observers are safe for the same reason.

Observation has its own signal and timeout. Aborting or timing out an observer
does not cancel or bound remote work, and another observer can rejoin later.
Only `dispatch.cancel({ signal })` requests remote cancellation.

Terminal protocol states resolve as a discriminated
`A2AConsumerTerminalOutcome`:

| `status` | Additional value |
| --- | --- |
| `completed` | `response` |
| `failed` | `response` and `A2AConsumerError` with `remote_failed` |
| `canceled` | `response` and `A2AConsumerError` with `remote_canceled` |
| `rejected` | `response` and `A2AConsumerError` with `remote_rejected` |
| `auth_required` | `response` and `A2AConsumerError` with `remote_auth_required` |
| `input_required` | `response` and `A2AConsumerError` with `remote_input_required` |

Transport, discovery, observer-timeout, and idempotency-integrity failures still
reject. In particular, `idempotency_conflict`, `idempotency_in_doubt`, and
`idempotency_result_expired` are not terminal business outcomes and must be
handled by the supervising caller.

For a one-shot admission, `dispatchA2AMessage({ agentUrl, ... })` creates the
consumer and returns the same dispatch handle. After a caller process restart,
repeat the same function with the original canonical payload and key; a
retained terminal result is replayed, while an active admission whose outcome
cannot be proven fails closed with `idempotency_in_doubt`.

`createA2AConsumerResponder` never invents a key. Supply a resolver when the
local request already carries a stable identity:

```ts
const responder = createA2AConsumerResponder({
  agentUrl,
  idempotencyKeyForRequest(request) {
    return typeof request.metadata?.delegationId === "string"
      ? request.metadata.delegationId
      : undefined;
  },
});
```

Permanent/operator-visible failures are `idempotency_conflict`,
`idempotency_in_doubt`, `idempotency_result_expired`,
`idempotency_capacity_exhausted`, `idempotency_unsupported`, and
`invalid_idempotency_key`. They must not enter an automatic retry loop. The
extension guarantees at-most-one automatic responder invocation for a durable
admission; it does not assert exactly-once external effects or an unambiguous
business outcome.

## Dynamic remote-agent selection

The responder you create from `createA2AConsumerResponder` is bound to a single `agentUrl`. To pick a remote agent **per request**, read plugin `config.consumer.remoteAgentUrls` / `defaultRemoteAgentUrl` from config and construct (or look up a cached) responder for the chosen URL at routing time. A simple pattern is a small map keyed by URL:

```ts
import { createA2AConsumerResponder } from "@mono-agent/a2a-adapter";

const responders = new Map<string, ReturnType<typeof createA2AConsumerResponder>>();

function responderFor(agentUrl: string) {
  let r = responders.get(agentUrl);
  if (!r) {
    r = createA2AConsumerResponder({
      agentUrl,
      bearerToken: process.env.MONO_AGENT_A2A_CONSUMER_BEARER_TOKEN,
      timeoutMs: 30_000,
    });
    responders.set(agentUrl, r);
  }
  return r;
}

// Route: use the per-request URL if allowed, else the default.
const target = chosenUrl && allowed.has(chosenUrl) ? chosenUrl : defaultRemoteAgentUrl;
const response = await responderFor(target).respond(request, stream);
```

Validate any caller-supplied URL against `remoteAgentUrls` before dialing it, so a request cannot redirect your agent to an arbitrary endpoint.

:::tip
Because each responder discovers the Agent Card lazily and caches the client, keeping responders in a map (rather than creating one per turn) avoids re-fetching the card on every request.
:::

## Discovery and one-shot send

For lower-level use, the adapter also exposes discovery and a fire-and-forget send:

- `discoverA2AAgent({ agentUrl })` — fetches and validates the remote Agent Card (name, supported interfaces, capabilities such as `streaming`). Useful to confirm reachability and feature support before routing to a remote agent.
- `sendA2AMessage({ agentUrl, text, ... })` — discovers the card and sends a single message, returning the response and its A2A metadata (`remoteAgentUrl`, `protocolVersion`, `taskId`, `contextId`, `state`). Convenient for scripts and one-off calls where you do not need a persistent responder.

## Related

- [A2A channel](/channels/a2a/) — the provider side: exposing your agent over A2A with plugin `config.provider`, `config.agent`, and `config.skill`.
- [A2A provider and consumer playbook](/playbooks/a2a-provider-and-consumer/) — end-to-end walkthrough wiring both halves together.
- [Multi-agent](/programmatic/multi-agent/) — composing remote responders into a routing host.
- [Composition](/programmatic/composition/) — how responders are assembled programmatically.

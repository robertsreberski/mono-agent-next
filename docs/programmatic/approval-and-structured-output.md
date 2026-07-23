---
title: "Approval gates & structured output"
description: "Add host-driven tool approvals, structured output, and live in-flight steering through the runtime API."
sidebar:
  order: 2
---

This page covers three runtime capabilities that have no `mono-agent.config.json`
knobs: human-in-the-loop tool approval, structured output on capable bridges,
and live in-flight input steering. The direct runtime APIs are **code-only**.
The managed Slack, Telegram, and web-console hosts additionally expose live
steering automatically when the selected backend supports it.

The closest config-level lever is `runtime.permissionMode`, the declarative tool-permission posture for CLI backends. It is unrelated to the callback-driven approval gates below, but it is the right tool when you want a static posture rather than an interactive prompt — see [Execution effort & permissions](/runtime/execution-effort-permissions/) and [Tool policy](/tools/policy/).

## Human-in-the-loop approval gates

Approval gates let your host pause a tool call, ask a human (or another system)
to approve or deny it, and resume. Set `policy.approvals.default` to `ask` and
provide an `AgentInteractionHandler` on the submitted request. The handler is
the programmatic UI boundary for both approval and `AskUser` interactions.

`code` — coverage type. See `runtime.approval-gates` in the [feature registry](/reference/feature-registry/).

| Surface | Purpose |
| --- | --- |
| `policy.approvals.default` | Selects `allow`, `deny`, or interactive `ask`. |
| `policy.approvals.timeoutMs` | Bounds an interactive request; timeout fails closed. |
| `AgentInteractionHandler.requestApproval` | Returns one correlated `allow_once` or `deny` decision. |
| `AgentInteractionHandler.askUser` | Answers a correlated bounded `AskUser` request. |

<!-- doc-test:typescript -->

```ts
import { createAgentHost } from "@mono-agent/core";
import type { AgentInteractionHandler } from "@mono-agent/module-sdk";

const interactionHandler: AgentInteractionHandler = {
  async requestApproval(request) {
    console.log(request.displayName, request.effects, request.summary);
    return {
      interactionId: request.interactionId,
      decision: request.effects.includes("execute") ? "deny" : "allow_once",
      decidedAt: new Date().toISOString(),
    };
  },
  async askUser(request) {
    return {
      interactionId: request.interactionId,
      answers: Object.fromEntries(
        request.questions.map((question) => [question.id, []]),
      ),
      answeredAt: new Date().toISOString(),
    };
  },
};

const host = await createAgentHost("./mono-agent.config.json");
try {
  await host.submit({
    requestId: "approval-example-1",
    conversationId: "review",
    text: "Inspect README.md.",
    interactionHandler,
  });
} finally {
  await host.stop();
}
```

Approval fallback is deterministic: malformed answers, handler failures, and
timeouts become `deny`, and `allow_once` authorizes only the correlated call.
Core never widens the configured tool allow/deny intersection.

:::tip
Keep low-risk tools in the configured allowlist and use `ask` for governed tools
whose effects need a human decision.
:::

### When to use `runtime.permissionMode` instead

If you do not need interactive, per-call decisions, the config-level posture is simpler and requires no host code:

```json
{
  "runtime": {
    "permissionMode": "default"
  }
}
```

Env var: `MONO_AGENT_PERMISSION_MODE` (`default` / `plan` / `acceptEdits` / `bypassPermissions`). This applies to CLI backends and is a static posture, not a callback. See [Execution effort & permissions](/runtime/execution-effort-permissions/).

## Structured output

`AgentSubmitInput.responseSchema` supplies a JSON schema to capable runtimes.

`code` — coverage type. See `runtime.structured-output` in the [feature registry](/reference/feature-registry/).

<!-- doc-test:typescript -->

```ts
import { createAgentHost } from "@mono-agent/core";

const host = await createAgentHost("./mono-agent.config.json");
try {
  const response = await host.submit({
    requestId: "structured-example-1",
    conversationId: "incident",
    text: "Summarize the incident and assign low or high priority.",
    responseSchema: {
      type: "object",
      properties: {
        summary: { type: "string" },
        priority: { type: "string", enum: ["low", "high"] },
      },
      required: ["summary", "priority"],
      additionalProperties: false,
    },
  });
  console.log(response.message ?? response.text);
} finally {
  await host.stop();
}
```

:::caution
Backend support varies. Claude SDK, Claude CLI, and Pi return captured JSON in
`structuredResult`. Codex app-server enforces the schema but returns the JSON in
`text`, so the host must parse it. Direct OpenCode rejects `outputSchema` with a
typed capability mismatch. In every case, validate the value in host code before
using it for state changes.
:::

For per-request schemas in a hosted responder, set `outputSchema` from `runtimeOptionsForRequest` (the `harness.request-runtime-options` hook) so each request can carry its own schema. See [composition](/programmatic/composition/) for the responder wiring.

## Live input steering

`AgentHost.offerLiveInput()` injects an additional user message while a turn is
running. It reports whether the active runtime applied the message, whether the
caller should requeue it as a normal turn, or whether it was unavailable or
discarded.

`auto + code` — coverage type. See `runtime.live-input` in the [feature registry](/reference/feature-registry/).

<!-- doc-test:typescript -->

```ts
import { createAgentHost } from "@mono-agent/core";

const host = await createAgentHost("./mono-agent.config.json");
try {
  const turn = host.submit({
    requestId: "analysis-example-1",
    conversationId: "incident",
    text: "Analyze this incident.",
  });
  const status = await host.offerLiveInput("incident", {
    id: "steer-1",
    text: "Also list any unresolved questions.",
    receivedAt: new Date().toISOString(),
  });
  if (status === "requeue") {
    console.log("Submit the guidance as the next normal turn.");
  }
  await turn;
} finally {
  await host.stop();
}
```

The generator above demonstrates the provider-facing shape. A custom host
usually backs the iterable with a queue that its UI can push to during the run.
A direct runtime call fails capability checks when its bridge cannot represent
live input instead of silently dropping the stream. Claude SDK, Codex app-server,
and Pi support it; the one-shot Claude CLI and direct OpenCode bridges do not.

After a capable bridge calls `acknowledge()`, the runtime publishes exactly one
metadata-only `live_input_applied` event containing `inputId` and optional
`receivedAt`. It never copies the guidance body into that event, and router
replay or duplicate acknowledgement cannot publish it twice. The standard
responder correlates the id to its pending human message and projects a normal
completed tool lifecycle named `↪️ Steered: “<safe preview>”`, with result
`Applied to current run`. The preview is one line, secret-redacted, path-collapsed,
and capped at 40 Unicode code points; the full text remains the human message.
Every structured stream therefore receives the same applied-steering activity
without adding a new channel-specific event type.

The standard agent responder owns that queue for ordinary interactive turns.
Slack and Telegram reserve the incoming message's normal per-conversation queue
position before offering it; the web console persists the same fallback in
SQLite. If the selected backend is unsupported, delivery fails, or the active
turn closes first, the message becomes the next normal turn. Once acknowledged,
it is appended to canonical history in arrival order and included in memory
persistence. Explicit cancellation discards unsettled guidance. Attachments,
commands, and `AskUser` answers retain their existing non-steering paths.

## Related

- [Composition](/programmatic/composition/) — building on `createMonoRuntime` and configured responders.
- [Multi-agent](/programmatic/multi-agent/) — orchestrating collaborator responders.
- [Execution effort & permissions](/runtime/execution-effort-permissions/) — config-level `permissionMode` posture.
- [Tool policy](/tools/policy/) — allow/deny lists and tool guards.

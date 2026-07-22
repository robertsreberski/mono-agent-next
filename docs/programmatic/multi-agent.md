---
title: "Multi-agent orchestration"
description: "Expose named structural responders through one request-scoped AskCollaborator MCP tool."
sidebar:
  order: 3
---

This page covers wiring one agent (the *orchestrator*) so its model can delegate to other agents (*collaborators*) at its own discretion, using `createCollaboratorToolRuntimeExtension` from `@mono-agent/agent-orchestrator`. Delegation is model-directed: the extension publishes one `AskCollaborator` MCP tool, bound to loopback by default, and the orchestrator model decides whether, when, and how often to call it before producing the final answer.

This is a **code**-only capability — there is no config key for it. See the feature row `orchestrator.ask-collaborator` in the [feature matrix](/reference/feature-matrix/) and the [end-to-end orchestration playbook](/playbooks/multi-agent-orchestration/).

## How it works

`createCollaboratorToolRuntimeExtension` starts a request-scoped MCP HTTP server, using loopback and an ephemeral port by default. The server exposes one tool (`AskCollaborator` by default). When the orchestrator model calls it, the extension routes the request to the named collaborator's `AgentResponder.respond(...)` and returns the collaborator's text back to the model as the tool result.

- The tool description lists every collaborator by `id`, `label`, and optional `description`, so the model knows who it can ask.
- Each collaborator is just an `AgentResponder`. It can be an in-process responder, or a remote agent reached over A2A via `createA2AConsumerResponder` (see [using an A2A consumer](/programmatic/a2a-consumer/)). The orchestrator does not care which.
- Collaborator failures surface as **visible tool errors** to the model (status `failed`), not hidden fallbacks — the orchestrator can decide how to recover.
- The server defaults to loopback (`127.0.0.1`) and fails closed: a non-loopback host throws unless you pass `allowNonLoopback: true`. That opt-in exposes an endpoint with no package-owned bearer authentication, so place it behind a trusted network or an authentication boundary you control.

:::note
The extension is request-scoped. You create it inside `runtimeOptionsForRequest` (one server per request) and return its `cleanup` so the host tears the MCP server down when the turn ends.
:::

## API

```ts
import { createCollaboratorToolRuntimeExtension } from "@mono-agent/agent-orchestrator";
```

### `createCollaboratorToolRuntimeExtension(options)`

| Option | Type | Default | Notes |
| --- | --- | --- | --- |
| `collaborators` | `OrchestratorCollaborator[]` | (required) | At least one; ids must be unique and match `^[A-Za-z0-9_-]+$`. |
| `conversationId` | `string` | (required) | Orchestrator conversation id. Each collaborator turn uses `${conversationId}:${id}`. |
| `originalUserMessage` | `string` | (required) | The user's request; prepended to every collaborator prompt for context. |
| `abortSignal` | `AbortSignal` | (required) | Parent turn signal; aborting cancels in-flight collaborator calls. |
| `maxCalls` | `number` | `6` | Hard cap on total `AskCollaborator` calls per request. Further calls return a visible error. |
| `toolName` | `string` | `"AskCollaborator"` | Tool name exposed to the model. |
| `serverName` | `string` | `"collaborators"` | MCP server key in `runtimeOptions.mcpServers`. |
| `host` / `port` / `path` | `string` / `number` / `string` | `127.0.0.1` / `0` (ephemeral) / `/mcp` | Bind address, port, and route. Keep the default loopback host unless the explicit non-loopback exposure is intended. |
| `allowNonLoopback` | `boolean` | `false` | Required to bind a non-loopback host. |

Each `OrchestratorCollaborator` is `{ id, label, responder, description?, timeoutMs? }`. `timeoutMs` is a **per-collaborator** deadline that aborts the signal passed to `responder.respond(...)`. A responder that ignores cancellation may still finish and record its own trace after the orchestrator stops waiting.

The returned `CollaboratorToolRuntimeExtension` has:

| Field | Type | Notes |
| --- | --- | --- |
| `runtimeOptions` | `{ allowedTools, mcpServers }` | Spread into the orchestrator's per-request runtime options. `allowedTools` contains just the collaborator tool; `mcpServers[serverName]` is `{ type: "http", url }`. |
| `url` / `toolName` / `serverName` | `string` | The bound server URL and resolved names. |
| `cleanup()` | `() => Promise<void>` | Closes the ephemeral MCP server. Idempotent. Always call it (return it from `runtimeOptionsForRequest`). |

## Wiring into the orchestrator

Build the orchestrator responder with `createConfiguredAgentResponder` (from `@mono-agent/agent-app`; see [programmatic composition](/programmatic/composition/)) and supply `runtimeOptionsForRequest`. This per-request hook — feature row `harness.request-runtime-options` — is where you create the extension and hand back its `runtimeOptions` and `cleanup`:

The snippet assumes the host has loaded `orchestratorCoreConfig`, selected an
`orchestratorRuntime`, and resolved `researcherUrl`, `workerUrl`, and `timeoutMs`.

```ts
import { createConfiguredAgentResponder } from "@mono-agent/agent-app";
import {
  createCollaboratorToolRuntimeExtension,
  type OrchestratorCollaborator,
} from "@mono-agent/agent-orchestrator";
import { createA2AConsumerResponder } from "@mono-agent/a2a-adapter";

const collaborators: readonly OrchestratorCollaborator[] = [
  {
    id: "researcher",
    label: "Researcher",
    description: "Find current external context when it materially helps.",
    responder: createA2AConsumerResponder({
      agentUrl: researcherUrl,
      timeoutMs,
      streamRemote: true,
    }),
    timeoutMs,
  },
  {
    id: "worker",
    label: "Worker",
    description: "Inspect the dedicated local workspace with read-only tools.",
    responder: createA2AConsumerResponder({
      agentUrl: workerUrl,
      timeoutMs,
      streamRemote: true,
    }),
    timeoutMs,
  },
];

const orchestrator = await createConfiguredAgentResponder({
  config: orchestratorCoreConfig,
  runtime: orchestratorRuntime,
  runtimeOptionsForRequest: async (input) => {
    const extension = await createCollaboratorToolRuntimeExtension({
      conversationId: input.request.conversationId,
      originalUserMessage: input.request.userMessage,
      abortSignal: input.request.abortSignal,
      collaborators,
    });
    return {
      runtimeOptions: extension.runtimeOptions,
      cleanup: extension.cleanup,
    };
  },
});
```

:::caution
Do not reuse one extension across requests. A new server is created per turn and `cleanup` closes it; returning `cleanup` from `runtimeOptionsForRequest` lets the host close it deterministically even if the turn errors or is aborted.
:::

## Example topology

A typical local setup runs three roles, each built from `@mono-agent/agent-app`, where the orchestrator reaches the other two over **loopback A2A**:

| Role | Transport | Tool policy | Trace name |
| --- | --- | --- | --- |
| Orchestrator | Telegram (when configured) + loopback A2A; calls `AskCollaborator` | decides delegation, then synthesizes | `multi-agent-orchestrator` |
| Researcher | loopback A2A provider | `WebSearch`, `WebFetch` allowed | `multi-agent-researcher` |
| Worker | loopback A2A provider | `Read`, `Grep`, `Bash` allowed; `Write`/`Edit` disallowed | `multi-agent-worker` |

The orchestrator's `AskCollaborator` tool fronts two `createA2AConsumerResponder` collaborators (`researcher`, `worker`). The model may ask one, both, or either repeatedly before answering; a successful turn that uses both records three JSONL runs (and Phoenix spans when an OTLP exporter is configured — see [Phoenix and backfill](/observability/phoenix-and-backfill/)). Distinct [per-role tool policies](/tools/policy/) keep the researcher and worker scoped to their jobs.

Local Ollama collaborators can take longer than the 60s A2A consumer default when running web or workspace tools before synthesis, so host code can set a longer per-collaborator timeout for those responders.

## Related

- [Programmatic composition](/programmatic/composition/) — building responders from config with `@mono-agent/agent-app`.
- [A2A consumers](/programmatic/a2a-consumer/) — consuming remote agents as responders or collaborators.
- [A2A provider channel](/channels/a2a/) — exposing an agent as an A2A provider.
- [MCP tools](/tools/mcp/) — how loopback collaborator servers are wired.
- [Multi-agent orchestration playbook](/playbooks/multi-agent-orchestration/) — full walkthrough.

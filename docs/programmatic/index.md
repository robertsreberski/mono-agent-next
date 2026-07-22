---
title: "Programmatic"
description: "Embed the config-first host or a configured responder when you need custom transports, runtimes, or request-scoped behavior."
sidebar:
  order: 0
---

Use these code entry points when `mono-agent.config.json` cannot express the host you need. If a behavior is already configurable, start with [Configuration](/config/) and the [Feature Matrix](/reference/feature-matrix/).

Most agents use the CLI host. Embed the app only when you need a custom driver set, a request-scoped runtime extension, or a responder inside your own server, queue, or test process.

## Three entry points, three altitudes

| Altitude | Package | Entry point | Use when |
| --- | --- | --- | --- |
| App (default) | `@mono-agent/agent-app` | `startMonoAgentApp({ cwd, configPath, drivers, runtime })` | You want the full config-first host but need to override the channel driver set, inject a runtime, or embed it in a larger process. |
| Responder | `@mono-agent/agent-app` | `createConfiguredAgentResponder({ config, memory, historyStore, runtimeOptions, runtimeOptionsForRequest })` | You want config-driven runtime/harness/memory composition but you own the transport (your own server, queue, or test harness). |
| Bare | `@mono-agent/agent-app` + `@mono-agent/config` | `loadMonoAgentConfigWithSources(...)` → `createConfiguredAgentResponder({ config })` | You want the smallest config-driven responder, without channels or host-level service/scheduler lifecycle. Per-run JSONL recording and configured exporters still apply. |

All three use the same `MonoAgentConfig`. The escape hatch changes composition and request handling; it does not require you to rebuild runtime, prompt assembly, or memory.

## `startMonoAgentApp` — the full host, your way

`startMonoAgentApp` is the app host used after the CLI has prepared its environment and managed lifecycle. With no options, the function resolves `mono-agent.config.json` from `cwd`, starts traceability and services, then starts the built-in drivers plus configured `channels.plugins[]` packages in parallel.

```ts
import { startMonoAgentApp } from "@mono-agent/agent-app";

const app = await startMonoAgentApp({ cwd: process.cwd() });
// ... later
await app.stop();
```

The options that make this an escape hatch:

| Option | Type | Effect |
| --- | --- | --- |
| `cwd` | `string` | Root for resolving `configPath` and relative config paths. Defaults to `process.cwd()`. |
| `configPath` | `string` | Path to the config file; defaults to `<cwd>/mono-agent.config.json`. |
| `drivers` | `readonly ChannelDriver[]` | The channel drivers to run. Defaults to core built-ins plus configured `channels.plugins[]` packages. Pass a subset to run, say, only Telegram and Cron. |
| `runtime` | `MonoRuntimeLike` | A shared runtime override (testing or advanced composition). When omitted the host builds the runtime from `runtime.model` plus canonical `runtime.fallbacks` (or legacy `fallbackModels`). |
| `env` | `Record<string, string \| undefined>` | Exact environment used for documented `MONO_AGENT_*` overrides; defaults to `process.env`. The function does not load `.env`. |
| `logger` | `MonoAgentAppLogger` | Structured logger for channel/trace lifecycle. |

The returned `MonoAgentApp` exposes status for channels, traceability, exporters, and sandboxing, plus `startChannelIfConfigured(id, reason)`, `applyConfigChange(reason)`, and `stop()`.

:::note
The host does not watch config files. Restart it, or call `app.applyConfigChange(reason)` to stop and rebuild the current services and reconfigure its already-resolved drivers from the updated config. Adding or removing a plugin package still requires a restart because the driver set is resolved at startup.
:::

Channels start independently. Enabled but incomplete channels report `waiting_for_config`; self-recovering transports can report `degraded` without stopping other channels. See [Channels](/channels/).

## `createConfiguredAgentResponder` — bring your own transport

When you own the transport but still want config-driven runtime, harness, and memory, build a responder directly with `@mono-agent/agent-app`. This is the layer `agent-app` itself calls internally.

```ts
import { BufferedMessageStream } from "@mono-agent/agent-contracts";
import { loadMonoAgentConfigWithSources } from "@mono-agent/config";
import { createConfiguredAgentResponder } from "@mono-agent/agent-app";

// The loader uses only the env record supplied here. Load dotenv yourself first
// if this process needs one.
const config = await loadMonoAgentConfigWithSources({
  env: process.env,
  cwd: process.cwd(),
  jsonPath: "./mono-agent.config.json",
});

const responder = await createConfiguredAgentResponder({ config });
const stream = new BufferedMessageStream();
const abort = new AbortController();
const result = await responder.respond(
  {
    conversationId: "demo",
    text: "hello",
    abortSignal: abort.signal,
  },
  stream,
);

console.log(result.text ?? stream.text);
```

Every `respond` call requires an `AbortSignal` and an `AgentMessageStream`. Connect the signal to your transport's cancel or disconnect behavior. The stream receives status, text, and structured runtime events; `BufferedMessageStream` is useful when your transport only needs the final text.

Notable options on `createConfiguredAgentResponder`:

| Option | Type | Effect |
| --- | --- | --- |
| `config` | `MonoAgentConfig` | Required. Drives runtime model, tools, memory, per-run artifacts, and configured exporters. |
| `runtime` | `MonoRuntimeLike` | Shared runtime override; otherwise built from config. |
| `memory` | `MemoryStore` | Inject a pre-built memory store instead of letting the host build one from `config.memory`. See [Capture and Recall](/memory/capture-and-recall/). |
| `historyStore` | `ConversationHistoryStore` | Replace the owner-only disk-backed 64-message default with a custom store (for example Redis). |
| `turnHistoryEnricher` | `AgentHarnessTurnHistoryEnricher` | Enrich only the assistant history copy with run-scoped interaction evidence; delivered text and memory capture are unchanged. |
| `runtimeOptions` | static runtime options | Static per-harness runtime options merged on every turn. |
| `runtimeOptionsForRequest` | `(input) => extension \| Promise<extension>` | Compute **request-scoped** runtime options (extra tools, metadata) per turn from the request and `runId`. Configured memory adds `MemoryRecall` automatically and composes it with this callback; `agent-app` also uses the callback for adapter send-tools. |

:::tip
`runtimeOptionsForRequest` returns an *extension* that is composed onto the static options — it does not replace them. Use it for per-request decisions (which tools this caller may use, request metadata for proactive notify) rather than for static policy, which belongs in config under [Tool Policy](/tools/policy/).
:::

The responder also honors warm-session mode and rollover from `runtime.session`. Durable conversation history remains separate from warm provider-session reuse. See [Sessions and concurrency](/runtime/sessions-concurrency/).

## A bare responder — `@mono-agent/agent-app` + `@mono-agent/config`

The minimal local host is just two packages: load a config, build a responder. It starts no channels and owns no host-level trace registry, service, retention, or memory-consolidation scheduler lifecycle. Each turn still uses the config-driven JSONL recorder and any configured per-run exporter.

```ts
import { loadMonoAgentConfigWithSources } from "@mono-agent/config";
import { createConfiguredAgentResponder } from "@mono-agent/agent-app";

const config = await loadMonoAgentConfigWithSources({
  env: process.env,
  cwd: process.cwd(),
  jsonPath: "./mono-agent.config.json",
});

const responder = await createConfiguredAgentResponder({ config });
```

This corresponds to the **Core Join** in the package map: `agent-contracts` (request/response shape), `config` (settings), `runtime-adapter` (model refs and execution-mode validation), and `agent-app` (turns config into a responder). For finer control of runtime, memory, history, recorder, or request-scoped options, drop to `@mono-agent/agent-harness` directly — that is the **Execution Join** and is fully code-only.

:::note
Only the `env` record passed to `loadMonoAgentConfigWithSources` participates in overrides. The loader does not load `.env` and does not implicitly merge `process.env`. See [Environment variables](/config/env-vars/).
:::

## In this section

- [Composition](/programmatic/composition/) — package joins, the smallest set per host, and what each layer owns vs. does not own.
- [Approval and Structured Output](/programmatic/approval-and-structured-output/) — gating tool calls and returning typed results from a responder.
- [Multi-Agent](/programmatic/multi-agent/) — `@mono-agent/agent-orchestrator`: one runtime calling named collaborator responders through a bounded MCP tool.
- [A2A Consumer](/programmatic/a2a-consumer/) — calling another agent's Agent Card from your host with `@mono-agent/a2a-adapter`.
- [Write your own channel adapter](/programmatic/custom-channels/) — writing a `ChannelDriver` package or composing an edge adapter directly to feed your own transport into a responder.

---
title: "Composition & custom runtimes"
description: "Choose the full app, configured responder, custom runtime, or lower-level harness for a programmatic host."
sidebar:
  order: 1
---

This page covers the three programmatic entry points that the `mono-agent` CLI itself is built on — `startMonoAgentApp` (full host with channels), `createConfiguredAgentResponder` (bare responder, no transports), and the lower-level `@mono-agent/agent-harness` — plus how to inject a custom runtime, add a channel driver, and scope runtime options per request. Reach for these only when `mono-agent.config.json` cannot express your host; the config covers nearly everything (see [feature coverage](/reference/feature-matrix/)). This whole surface is **code**-coverage: it is not reachable from config or the CLI.

## Choosing an entry point

| Entry point | Package | You get | Use when |
| --- | --- | --- | --- |
| `startMonoAgentApp` | `@mono-agent/agent-app` | Config load + responder + every configured channel + traceability + exporters | You want a CLI-equivalent host, optionally with extra channel drivers or a shared runtime |
| `createConfiguredAgentResponder` | `@mono-agent/agent-app` | A transport-free `AgentResponder` with config-driven runtime, harness, memory, per-run JSONL recording, and configured exporters | You embed the responder in your own server, test harness, or custom transport |
| `createAgentHarness` / `createAgentResponder` | `@mono-agent/agent-harness` | Full manual control of identity, skills, memory, history, recorder, runtime | Config-driven composition is not enough and you assemble every dependency yourself |

The layering is strict: `agent-app` owns config-driven composition and delegates turn execution to `agent-harness`. Drop down only one level at a time. See [package map](/programmatic/) and the [programmatic index](/programmatic/) for the broader package set.

## The full host: `startMonoAgentApp`

`startMonoAgentApp` is what the CLI's `mono-agent start` runs. It loads `mono-agent.config.json` from `cwd`, builds the responder through app-owned configured composition, and starts traceability, observability exporters, every configured channel, and memory consolidation.

```ts
import { startMonoAgentApp } from "@mono-agent/agent-app";

const app = await startMonoAgentApp({ cwd: process.cwd() });
// ... later
await app.stop();
```

`MonoAgentAppOptions` fields:

| Option | Type | Default | Notes |
| --- | --- | --- | --- |
| `cwd` | `string` | `process.cwd()` | Folder the config and relative paths resolve against |
| `configPath` | `string` | `<cwd>/mono-agent.config.json` | Path to the config file |
| `env` | `Record<string, string \| undefined>` | `process.env` | Source for `MONO_AGENT_*` overrides |
| `drivers` | `readonly ChannelDriver[]` | `resolveChannelDrivers(...)` | Which channels to run (see below); defaults to core built-ins plus configured `channels.plugins[]` packages |
| `runtime` | `MonoRuntimeLike` | built from config | Inject a shared/custom runtime (see below) |
| `logger` | `MonoAgentAppLogger` | console-backed | Structured host logging |

The host runs headless and does not watch the config file. After an edit, either restart the host or call `app.applyConfigChange(reason)` explicitly to stop and rebuild its current services and driver set. Adding or removing a plugin package still requires a restart because external drivers are resolved at startup.

### Adding a custom channel driver

`defaultChannelDrivers()` returns the core built-in channel drivers (Telegram, Slack, webhook, OpenAI API, cron, and TUI) in startup/status order. The CLI-equivalent default uses `resolveChannelDrivers(...)`, which appends external packages declared under `channels.plugins[]` such as WhatsApp or A2A. Spread `defaultChannelDrivers()` and append your own driver for a code-only host — or expose a package-level `createChannelDriver()` and load it from config.

```ts
import { startMonoAgentApp, defaultChannelDrivers } from "@mono-agent/agent-app";
import { myCustomDriver } from "./my-driver.js";

const app = await startMonoAgentApp({
  cwd: process.cwd(),
  drivers: [...defaultChannelDrivers(), myCustomDriver],
});
```

For building the driver itself, see [Write your own channel adapter](/programmatic/custom-channels/).

## The bare responder: `createConfiguredAgentResponder`

When you do not want any built-in transport — you are embedding the agent in your own HTTP server, queue worker, or test — combine `@mono-agent/config` with `@mono-agent/agent-app`. `createConfiguredAgentResponder` turns a loaded `MonoAgentConfig` into a ready `AgentResponder`. It starts no channel, trace-registry, service, retention, or consolidation-scheduler lifecycle, but each turn still uses the configured JSONL recorder and per-run exporters. It is **async** (as is `createConfiguredAgentHarness`/`createConfiguredMemory`): memory backends are imported lazily, so a config without a `memory` section never loads the SQLite/BuJo stack and a Supermemory config never loads it either.

```ts
import { loadMonoAgentConfigWithSources } from "@mono-agent/config";
import { createConfiguredAgentResponder } from "@mono-agent/agent-app";

const config = await loadMonoAgentConfigWithSources({
  env: process.env,
  cwd: process.cwd(),
  jsonPath: "./mono-agent.config.json",
});

const responder = await createConfiguredAgentResponder({
  config,
  cwd: process.cwd(),
});
```

For `memory.backend: "supermemory"`, install the exact matching
`@mono-agent/memory-supermemory` plugin first. The app imports it only when that
backend is selected and reports the exact matching-version install command when
it is absent; other configurations keep it outside the app dependency closure.

`ConfiguredAgentResponderOptions` (a superset of `ConfiguredAgentHarnessOptions`) lets you override the dependencies the config would otherwise build:

| Option | Type | Purpose |
| --- | --- | --- |
| `config` | `MonoAgentConfig` | **Required.** The loaded config |
| `cwd` | `string` | Agent folder used to resolve agent-local optional plugins (defaults to `process.cwd()`) |
| `runtime` | `MonoRuntimeLike` | Inject a custom or shared runtime instead of building one from `runtime.model` |
| `model` / `executionMode` | `RuntimeModelReference` / `string` | Override the config's primary model / execution mode |
| `memory` | `MemoryStore` | Supply a memory store instead of provisioning from `config.memory` |
| `historyStore` | `ConversationHistoryStore` | Replace the configured app's owner-only disk-backed 64-message history store with a custom implementation |
| `turnHistoryEnricher` | `AgentHarnessTurnHistoryEnricher` | App-owned hook for adding run-scoped interaction evidence only to replay history; outward responses and memory capture keep the original assistant text |
| `runtimeOptions` | static run options | Extra runtime options merged for every run (no `model`/`messages`/`abortSignal`/`executionMode`/`onEvent`) |
| `runtimeOptionsForRequest` | `(input) => extension` | Per-request run options (see below) |

`createConfiguredAgentRuntime(config)` and `createConfiguredAgentHarness(options)` are also exported if you want the runtime or harness without the responder wrapper.

A custom `historyStore` keeps provider sessions process-local unless it implements the crash-safe `beginProviderSessionTurn` transaction and advertises `providerSessionRetirement: "fail-closed"`. That marker is a promise that epoch rotation, dirty-fence recovery, and retention can durably retire every exact provider id before canonical history makes it unreachable. The harness withholds `piSessionsRoot` when either half is missing.

## Injecting a custom runtime (`MonoRuntimeLike`)

Both `startMonoAgentApp` and the configured responder factories accept a `runtime?: MonoRuntimeLike` from `@mono-agent/runtime-adapter`. Pass one to share a single runtime across hosts, point at an unsupported backend, or stub the provider in tests. When omitted, the runtime is built from `config.runtime.model` plus canonical `runtime.fallbacks` (or legacy `runtime.fallbackModels`).

```ts
import { startMonoAgentApp } from "@mono-agent/agent-app";
import type { MonoRuntimeLike } from "@mono-agent/runtime-adapter";

const myRuntime: MonoRuntimeLike = createMyRuntime();

const app = await startMonoAgentApp({ cwd: process.cwd(), runtime: myRuntime });
```

:::caution
A custom runtime fully replaces model selection, so config keys like `runtime.model`, `runtime.executionMode`, `runtime.fallbacks`, and `runtime.routeSafety` no longer drive provider behavior — your runtime owns that. For the built-in runtime's model refs, execution modes, and fallback chain, see [backends](/runtime/backends/) and [fallback](/runtime/fallback/).
:::

Notes:

- The configured fallback chain is applied by the built-in runtime's router. An injected runtime bypasses that wiring, so your runtime owns retry and failover behavior.
- The BuJo memory LLM is separate from the channel runtime. `createConfiguredMemory(config, { memoryRuntime })` is the seam for tests or custom memory LLM execution; otherwise memory builds its own fallback-free runtime from `memory.llm`.
- Per-trigger model overrides from cron and webhook use `runtimeForModel`. A host with a custom runtime that should honor those overrides must also provide a `runtimeForModel(model, executionMode)` factory.

## Custom memory stores

The built-in memory tiers are config-driven through `memory.mode: "lite" | "journal" | "bujo"` for local storage. The optional Supermemory plugin retains its config-first route at `memory.backend: "supermemory"` after its matching package is installed. Anything else is a code capability: implement the structural `MemoryStore` contract from `@mono-agent/agent-contracts` and inject it into the configured composition layer.

```ts
import type { MemoryStore } from "@mono-agent/agent-contracts";
import { createConfiguredAgentResponder } from "@mono-agent/agent-app";

const memory: MemoryStore = createMyMemoryStore();

const responder = await createConfiguredAgentResponder({
  config,
  memory,
});
```

The injected store wins over anything `config.memory` would otherwise build, and `config.memory` can be omitted entirely. Recall happens before each turn and capture happens after the reply according to `memory.writeMode`; slow or failing memory degrades the memory path rather than faking a successful model turn.

## Per-request runtime options (`runtimeOptionsForRequest`)

`runtimeOptionsForRequest` is a callback invoked once per turn to compute run options scoped to that request. A configured memory backend attaches the per-turn `MemoryRecall` endpoint at the shared configured-harness boundary and composes it with your callback; supplying custom tools does not replace the default recall tool. The full app uses the same composition path for adapter send tools and request overrides.

```ts
import { createConfiguredAgentResponder } from "@mono-agent/agent-app";
import type {
  AgentHarnessRuntimeOptionsInput,
  AgentHarnessRuntimeOptionsExtension,
} from "@mono-agent/agent-harness";

const responder = await createConfiguredAgentResponder({
  config,
  runtimeOptionsForRequest: async (
    input: AgentHarnessRuntimeOptionsInput,
  ): Promise<AgentHarnessRuntimeOptionsExtension> => {
    // input: { request, runId, context }
    return {
      runtimeOptions: { /* per-run options, e.g. extra MCP servers */ },
      cleanup: async () => { /* release per-request resources */ },
    };
  },
});
```

The callback receives `{ request, runId, context }` (the inbound request, the run id, and the already-built `BuiltAgentContext`). It returns a partial `runtimeOptions` object plus an optional `cleanup` hook. `messages`, `abortSignal`, `executionMode`, `onEvent`, provider-session ids, keep-alive fields, and `piSessionsRoot` remain harness-owned. `model` and `effort` are accepted for the configured cron/webhook/TUI override path. A request extension may set `piTransport` only when the host left it unset; an explicit host/config value remains authoritative.

:::note
Request-scoped options apply at the harness **run boundary**: they are resolved after context assembly and merged just before the provider call, then `cleanup` runs when the turn finishes. A model-changing option under continuous-session mode must match a valid model already declared in the request's cron, webhook, or TUI metadata, because that declaration isolates the turn before history assembly. An undeclared late model change fails before provider execution; otherwise a warm session could have omitted history for the wrong runtime. Execution mode remains harness-derived from the effective model.
:::

## Dropping to the harness

`createConfiguredAgentResponder` will not cover hosts that need a custom recorder, a non-config identity/skill loading scheme, or hand-assembled memory and history. In those cases call `@mono-agent/agent-harness` directly. The harness owns loading identity/SOUL and selected skill bodies, reading memory blocks, invoking the runtime, recording run events, appending conversation history, and returning explicit failure objects instead of fake success.

Selected skills are never auto-selected by description — the host passes `selectedSkills` (or `config.context.selectedSkills`) and the harness loads exactly those bodies. For tool/MCP policy, build a policy with `@mono-agent/agent-harness` (`createToolPolicy`) and pass exactly the surface you want — `["*"]` for all, a specific list to narrow, or `[]` for none; `failClosedToolPolicy()` is the no-policy safety net (the config loader's allow-all default lives in `@mono-agent/config`, not here). See [tool policy](/tools/policy/) and [MCP](/tools/mcp/).

For multi-agent orchestration on top of these primitives, see [multi-agent](/programmatic/multi-agent/); for consuming a remote agent over A2A, see [A2A consumer](/programmatic/a2a-consumer/).

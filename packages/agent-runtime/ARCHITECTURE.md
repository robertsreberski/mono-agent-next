# Agent Runtime Architecture

## What It Is

`@mono-agent/agent-runtime` is a provider-agnostic agent execution
kernel. It does not own tasks, database state, UI, scheduling, or a host's
domain-specific result contract. It owns the lower-level act of running an
agent turn:

- pick the right backend from a model reference and execution mode
- expose built-in tools, MCP tools, approvals, structured output, and live input
- enforce an optional sandbox policy for built-in tool execution and stdio MCP
  startup, through an injectable seam (see `agent/sandbox-seam.js`) rather than
  a bundled sandboxing implementation
- normalize provider events into one runtime event stream
- classify runtime failures and retryable provider errors
- collect usage, cost, cache, capability, and warning telemetry
- return raw text plus raw structured output to the host

Hosts consume the package through `src/runtime.js`. The package has **zero
workspace-package dependencies**: everything a host-side integration would
otherwise need to inject (sandboxing, in this package's case) is expressed as
a plain-data/plain-function seam the host wires up, not an import.

## Package Boundary

**Diagram summary:** A host constructs `createRuntime()` or `createRouterRuntime()`.
The runtime selects one of five provider bridges while sharing observability,
failure normalization, and capability-specific agent-kernel services. It returns
a provider-neutral result for the host to interpret.

```mermaid
flowchart TB
  HostApp["Host app<br/>API / coordinator / worker / UI / DB"] --> CoreAI["host runtime composition"]

  CoreAI --> Runtime["agent-runtime<br/>createRuntime() / createRouterRuntime()"]

  Runtime --> Registry["Runtime bridge registry<br/>model ref + executionMode -> backend"]
  Runtime --> AgentKernel["Agent kernel<br/>built-in tools, MCP, approvals,<br/>compaction, transcript snapshots"]
  Runtime --> Observability["Observers + metrics<br/>usage, cost, events, warnings"]
  Runtime --> Failure["Failure taxonomy<br/>retryable provider detection"]

  Registry --> ClaudeSDK["Claude SDK bridge"]
  Registry --> ClaudeCLI["Claude Code CLI bridge"]
  Registry --> PiSDK["Pi SDK bridge<br/>OpenAI, Codex, Gemini, OpenRouter,<br/>Ollama, custom providers"]
  Registry --> CodexApp["Codex app-server CLI bridge"]
  Registry --> OpenCodeApp["OpenCode app-server CLI bridge"]

  AgentKernel --> Builtins["Read / Write / Edit / Glob / Grep / Bash<br/>NodeRepl / WebFetch / WebSearch"]
  AgentKernel --> MCP["MCP stdio / SSE / HTTP tools"]
  AgentKernel --> Sandbox["Sandbox policy<br/>path/network checks + stdio command wrapping"]
  AgentKernel --> Artifacts["Tool-output bloat guard<br/>host artifact persistence"]

  ClaudeSDK --> Providers["External model/provider surfaces"]
  ClaudeCLI --> Providers
  PiSDK --> Providers
  CodexApp --> Providers
  OpenCodeApp --> Providers

  Runtime --> Result["RuntimeResult<br/>text, structuredResult, events,<br/>usage, diagnostics, failureKind"]
  Result --> CoreAI
  CoreAI --> HostContract["Host parses domain contract<br/>assistant result / task effects"]
```

The runtime stays below host domain behavior. Provider code in this package
must not import host DB, API, coordinator, or UI modules. Hosts pass callbacks
and pre-resolved settings into the runtime instead.

## Runtime Selection

**Diagram summary:** Hosts may use `parseRuntimeModelReference()` to turn a
canonical string into the object required by `run()`. The static registry then
matches that object plus execution mode and lazily imports Claude SDK, Claude
Code CLI, Pi SDK, Codex app-server, or OpenCode app-server code. Capability
descriptors are available without loading those provider implementations.

```mermaid
flowchart LR
  AuthoredRef["authored model string"] --> Parse["parseRuntimeModelReference()"]
  Parse --> ModelRef["options.model<br/>parsed RuntimeModelRef"]
  ModelRef --> Mode["options.executionMode<br/>sdk or cli"]
  Mode --> Resolve["resolveRuntimeBridge()"]

  Resolve -->|sdk=claude + sdk mode| ClaudeSDK["claude bridge<br/>@anthropic-ai/claude-agent-sdk"]
  Resolve -->|sdk=claude + cli mode| ClaudeCLI["claude-code bridge<br/>claude binary"]
  Resolve -->|sdk=pi| PiSDK["pi bridge<br/>@earendil-works/pi-agent-core"]
  Resolve -->|sdk=codex + cli mode| CodexApp["codex-app bridge<br/>codex app-server"]
  Resolve -->|sdk=opencode + cli mode| OpenCodeApp["opencode-app bridge<br/>isolated OpenCode server"]

  Resolve --> Caps["runtimeCapabilities()<br/>static backend features"]
  Caps --> Used["capabilitiesUsed<br/>per-call observed features"]
```

Canonical active model references are:

- `claude:<modelId>` for Claude SDK or Claude Code CLI, selected by
  `executionMode`
- `pi:<providerId>:<modelName>` for Pi SDK providers
- `codex:<modelId>` for Codex app-server CLI
- `opencode:<providerId>:<modelName>` for the isolated OpenCode app-server CLI

`createRuntime().run()` expects this already-parsed object; it does not parse a
string implicitly.

Legacy aliases are canonicalized at host ingress when needed. The strict parser
keeps the package boundary honest by rejecting reserved runtime IDs such as
`openai:*`, `vercel:*`, and `claude-code:*`.

## Run Lifecycle

**Diagram summary:** The host calls `run()`, the runtime lazily loads one bridge,
and that bridge talks to its SDK or subprocess. Supported tool calls pass through
the shared kernel, provider events are normalized, and the host receives a result
that it must validate for its domain.

```mermaid
sequenceDiagram
  participant Host as Host app
  participant Runtime as createRuntime()
  participant Registry as Bridge registry
  participant Bridge as Provider bridge
  participant Kernel as Agent kernel
  participant Provider as SDK / CLI / app-server
  participant Observer as Observer hub

  Host->>Runtime: run(systemPrompt, options)
  Runtime->>Registry: resolveRuntimeBridge(model, executionMode)
  Registry-->>Runtime: bridge.execute()
  Runtime->>Observer: create hub from host + call observers
  Runtime->>Bridge: execute(systemPrompt, normalized options)

  opt bridge supports managed or MCP tool dispatch
    Bridge->>Kernel: prepare tools, MCP, approvals, limits
    Kernel-->>Bridge: provider-specific tool surface
  end
  Bridge->>Provider: send prompt, messages, tools, schema, settings

  loop streaming events
    Provider-->>Bridge: assistant/tool/result/provider events
    Bridge->>Observer: normalized runtime events
    opt provider requests host-dispatched tools
      Bridge->>Kernel: execute built-in/MCP tools
      Kernel-->>Bridge: tool results or tool errors
    end
  end

  Bridge-->>Runtime: RuntimeResult
  Runtime->>Observer: flush()
  Runtime-->>Host: text, structuredResult, events, usage, diagnostics
  Host->>Host: validate/parse host-specific contract
```

Claude SDK, Claude CLI, and Pi SDK can return provider-captured output as
`structuredResult`. Codex app-server receives the schema but returns its output
as text for the host to parse; direct OpenCode rejects the option. The package
does not validate any captured output against a host domain schema. Hosts own
that validation and all state-machine side effects.

## Main Subsystems

**Diagram summary:** The public barrels lead to the runtime factory, fallback
router, AI registry, and agent-kernel helpers. The registry owns five lazy
provider loaders. Shared agent modules own tools, context, approvals,
compaction, transcript snapshots, and result-size guards; shared AI modules own
failure, cost, observation, and capability metadata.

```mermaid
flowchart TB
  Public["Public API<br/>src/index.js"] --> RuntimeFactory["runtime.js<br/>createRuntime()"]
  Public --> Router["ai/runtime/router.js<br/>createRouterRuntime()"]
  Public --> AIExports["ai/index.js<br/>model refs, registry, observers"]
  Public --> AgentExports["agent/index.js<br/>allowlists, compaction,<br/>approvals, transcript"]

  RuntimeFactory --> Registry["ai/runtime/registry.js"]
  Registry --> Providers["ai/providers/*"]

  Providers --> Claude["claude-sdk.js"]
  Providers --> ClaudeCode["claude-cli.js"]
  Providers --> Pi["pi-native.js<br/>pi-models/messages/events"]
  Providers --> Codex["codex-app.js"]
  Providers --> OpenCode["opencode-app.js<br/>opencode-server.js"]

  AgentExports --> Tools["agent/tools/*"]
  Tools --> ToolContext["shared/tool-context.js<br/>per-instance ToolContext<br/>workspace, repoRoot, rg, sandbox, brand"]
  ToolContext --> ToolRuntime["shared/runtime-context.js<br/>back-compat DEFAULT context<br/>(module-level singleton wrapping tool-context.js)"]
  Tools --> PiBridge["tools/pi-bridge.js<br/>built-ins + MCP adaptation"]

  AgentExports --> Compaction["agent/compaction.js"]
  AgentExports --> Transcript["agent/transcript.js"]
  AgentExports --> Approval["agent/approval.js"]
  AgentExports --> Bloat["agent/tool-bloat.js"]

  AIExports --> Failure["ai/failure.js"]
  AIExports --> Cost["ai/cost.js"]
  AIExports --> Observer["ai/observer.js"]
  AIExports --> Capabilities["ai/runtime/capabilities*.js"]
```

Key responsibilities by subsystem:

- `runtime.js`: binds host callbacks once, builds a per-instance `ToolContext`
  (`agent/tools/shared/tool-context.js`) threaded to every bridge call via
  `options.toolContext`, and routes each call to the resolved bridge.
- `ai/runtime/registry.js`: keeps the five static bridge descriptors, exposes
  their metadata for introspection, and lazily imports the one whose model
  reference plus execution mode matches a run.
- `ai/runtime/router.js`: retries across an ordered fallback chain on retryable
  provider failures, carrying a transcript-tail resume snapshot forward.
- `ai/providers/*`: owns provider-specific request shapes, event conversion,
  structured-output extraction, native subagent wiring, usage, and diagnostics.
- `agent/tools/*`: implements built-in tools, path/workdir guards, sandbox
  policy checks, MCP tool adaptation, Playwright artifact routing, and output
  limits.
- `agent/sandbox-seam.js`: the injectable `RuntimeSandbox` interface (policy
  merge, command preparation, network-allow checks) and its zero-dependency
  `passthroughSandbox` default (no policy configured → unsandboxed, exactly as
  before; a policy configured with no implementation injected → fails closed).
  Real hosts inject `@mono-agent/runtime-adapter`'s sandbox implementation.
- `agent/compaction.js`: pure helpers consumed by the pi bridge —
  `resolveAgentCompactionPolicy` (derives the context-window compaction trigger +
  adaptive budgets and tool-output payload limits from the typed compaction
  policy and running model; deprecated `agent_compaction_*` settings remain a
  compatibility input), `estimateFixedOverheadTokens` (the proactive fixed-overhead correction:
  system prompt + tool schemas + per-turn message), `isLikelyContextTermination`
  (classifies a context-pressure error), and the typed-policy/`settings`-bag shim
  helpers (`resolveRuntimePolicyInputs`, `deprecatedSettingsWarning`) that let a
  present `toolLimits`/`compaction` object win wholesale per-group over the
  deprecated flat `settings` bag (MIGRATION.md §8). The bridge drives compaction
  itself via `AgentHarness.compact()` (proactive + reactive recovery); the legacy
  in-loop `transformContext` manager was removed.
- `agent/transcript.js`: builds bounded resume snapshots from prior provider
  events so a fallback or continuation can keep context.
- `agent/approval.js`: provides host-driven human-in-the-loop tool approval
  gates where the backend supports runtime tool dispatch.
- `ai/failure.js`: normalizes spawn, usage-limit, provider, cancellation, and
  retryability decisions into stable failure kinds.

## Host Responsibilities

**Diagram summary:** The host injects pricing, Pi credentials, artifact and
compaction persistence, tool-approval decisions, runtime branding, and allowed
filesystem roots. The runtime returns raw normalized data; the host owns domain
validation, durable state, and UI effects.

```mermaid
flowchart LR
  Host["Host app"] --> Pricing["resolveCustomPricing"]
  Host --> Auth["resolvePiApiKey"]
  Host --> Persist["persistArtifact"]
  Host --> Compact["onCompactionRecorded"]
  Host --> Approval["onToolApprovalRequest"]
  Host --> Brand["runtimeBrand"]
  Host --> Roots["workspace / repoRoot / ripgrepPath"]

  Pricing --> Runtime["agent-runtime host callbacks"]
  Auth --> Runtime
  Persist --> Runtime
  Compact --> Runtime
  Approval --> Runtime
  Brand --> Runtime
  Roots --> Runtime

  Runtime --> Raw["Raw runtime result"]
  Raw --> Domain["Host-owned domain validation<br/>result contract, state machine,<br/>DB writes, UI surfaces"]
```

The host is responsible for:

- resolving credentials and custom provider/model rows before provider calls
- choosing model references, execution mode, effort, fallback chains, and
  runtime settings
- persisting artifacts, raw logs, run rows, and UI-facing state (via the
  `onCompactionRecorded` hook, which fires on every automatic compaction —
  proactive or reactive — the pi bridge drives)
- validating structured output against the host's domain contract
- converting runtime failures into product workflow behavior
- deciding when to retry, recover, continue, cancel, or ask for user input

## Sessions, Follow-ups & Concurrency

When `runtime.session.mode = "continuous"`, the harness keeps a conversation's
provider session warm and serializes its turns through a per-conversation queue
(`@mono-agent/agent-harness` `LiveSessionManager`). A message that arrives while
a turn is in flight is **queued and answered on the warm session after the
current turn finishes** (queue-after-turn) rather than rejected — this is what
powers follow-up messages in chat channels. Different conversations run
concurrently; an optional `concurrency.maxConcurrentRuns` bounds simultaneous
model runs via admission control around the provider call (queued follow-ups
hold no slot, so the bound never deadlocks against the queue). Note this bound is
**per harness instance** — the app builds one harness per channel, so the limiter
is per-channel, not a single global cap; with N enabled channels the effective
ceiling is N× the configured value. Channels surface
a user cancel through `responder.cancel(conversationId)`, which aborts the
in-flight turn and clears that conversation's queue.

**Honest per-provider session behavior** — parity is *behavioral* (every
provider exposes queue-after-turn), not durability/cost:

The pi runtime is built on pi-agent-core's native `AgentHarness` (the hand-rolled
bridge was removed once native reached parity); it owns the session and
pi-ai-managed retry. `AgentHarness` itself has **no** automatic compaction, so
the pi bridge drives it through a one-shot `session_before_compact` hook: before
each turn it compares the full request estimate with an adaptive trigger, and if
a turn still overflows it retries exactly once only after a preview verifies a
positive reduction. Runs report `context_compaction_applied` as `true` (a
compaction fired), `false` (enabled but not needed), or `null` (disabled via
`runtime.compaction.enabled: false`).

| Provider | Warm session | Resume across turns | Survives process restart |
|---|---|---|---|
| **pi** | Yes (pi `AgentHarness` + JSONL session repo) | session repo | Yes only with `piSessionsRoot` and the durable history/session transaction contract |
| **claude-sdk** | No persistent process (stream closes at turn end) | `queryOptions.resume` | No (Anthropic-side id) |
| **claude-cli** | No — respawns `claude --resume` per turn (re-inits MCP) | `--resume` replay | No |
| **codex-app** | Live subprocess thread (dies with the subprocess) | next turn on the thread, else replay | No |
| **opencode-app** | No — every run uses an isolated server and private database | Unsupported | No |

Claude CLI and Codex only *approximate* a warm session (resume/replay), so do
not assume warm-session latency wins there. Direct OpenCode is intentionally
stateless across runs.

## Essential Takeaway

Think of `@mono-agent/agent-runtime` as the portable agent process engine
underneath a host app. The host decides what a task means, which agent should
run, how state changes, and how results are persisted. The runtime decides how
to talk to Claude, Pi, Codex, and OpenCode execution surfaces; how tools are
exposed; how provider failures are normalized; and how enough telemetry is
returned for a host to make reliable orchestration decisions.

---
title: "Built-in tools & auto-guards"
description: "Understand mono-agent's built-in tools and automatic protections for tool output, usage telemetry, context compaction, retries, and parallelism."
sidebar:
  order: 6
---

This page covers mono-agent's managed built-ins (Read, Write, Edit, Glob, Grep, Bash, NodeRepl, WebFetch, WebSearch) and the runtime guards that protect each turn: the tool-output bloat guard, per-run usage/cost tracking, bridge-driven Pi context compaction, and WebFetch's in-tool retry. It also notes which behaviors you configure versus which run automatically.

## Built-in tools

These tools need no extra capability config (coverage: `config` — they exist by default on the supporting runtime; you gate them):

| Tool | Purpose |
| --- | --- |
| `Read` | Read a file (text, images, PDFs, notebooks). |
| `Write` | Create or overwrite a file. |
| `Edit` | Exact-string replacement in a file. |
| `Glob` | Match files by glob pattern. |
| `Grep` | Search file contents. |
| `Bash` | Run a shell command. |
| `NodeRepl` | Evaluate JavaScript in a run-scoped Node.js REPL. |
| `WebFetch` | Fetch a URL and return its content. |
| `WebSearch` | Run a web search. |

These are gated by `tools.allowedTools` / `tools.disallowedTools`. Deny always wins, and listing the same tool in both is rejected at validation time. Mono-agent-managed built-ins are provided by the Pi bridge; provider-owned routes use their native tool surfaces. See [Tool Policy](/tools/policy/) for the full allow/deny semantics, plus [MCP tools](/tools/mcp/) and the [sandbox](/tools/sandbox/) for `Bash` and `NodeRepl` confinement.

```json
{
  "tools": {
    "allowedTools": ["Read", "Glob", "Grep", "WebFetch", "WebSearch"],
    "disallowedTools": ["Bash", "Write", "Edit"]
  }
}
```

Env equivalents: `MONO_AGENT_ALLOWED_TOOLS`, `MONO_AGENT_DISALLOWED_TOOLS` (comma-separated tool names).

:::note
An **omitted** `allowedTools` (or `["*"]`) allows **every** tool subject to `disallowedTools` — the allow-all default. Listing specific names narrows to those; an **explicit empty** `[]` allows none (a deliberate chat-only agent). Add names to `disallowedTools` to subtract from the open default without switching to a full allowlist.
:::

These are the normalized policy semantics, but the selected runtime must be able to enforce them. Direct `codex:*` normal runs currently accept exact allow-all only (`["*"]` or omitted, with no denylist); restrictive variants fail validation/runtime setup instead of being silently widened. See [Tool policy](/tools/policy/#allow-all-by-default).

## NodeRepl

`NodeRepl({ code })` uses Node's built-in [`node:repl`](https://nodejs.org/api/repl.html) default evaluator. Mono-agent lazily starts one child REPL for a run and reuses it for later `NodeRepl` calls in that run. Variables, the module cache, `_`, and `_error` therefore persist between calls; the child is destroyed when the run ends, so the next run starts clean. The evaluator supports multiline JavaScript, top-level `await`, Node built-ins, `console` output, and `require()` of packages already installed for the workspace.

This is code execution, with the same filesystem, process, and network authority as `Bash`. The child goes through the same sandbox preparation seam and configured SRT policy. With no active sandbox it runs on the host; with native SRT it receives the configured roots, deny-write rules, and network policy. A fixed 120-second evaluation timeout, abort, child exit, or hard output overflow kills the child and resets its state before a later call. Normal results use the existing tool-output cap.

`NodeRepl` is intentionally small: it has no session ids, persistent history, reset command, terminal emulation, or package installer. Use `Bash` for shell commands and install dependencies before the run. REPL dot commands such as `.save` and `.load` are not a supported tool interface.

## Tool-output bloat guard (auto)

Tool results are truncated at a 256KB budget so a single oversized result cannot blow up the context window or the model's reasoning. When a result exceeds the budget, the guard attempts to save each original block through the artifact sink. The compact replacement references only paths the sink successfully returned; if the sink is absent or a write fails, omitted bytes are not recoverable. Successful files land under `artifacts.dir/tool-output/` and are separate from JSONL replay.

Images get a separate, larger budget than text so vision payloads are not clipped at the text limit.

This guard is always on (coverage: `auto`). You do not enable it; you only choose where artifacts are written:

```json
{
  "artifacts": {
    "dir": ".mono-agent/artifacts"
  }
}
```

Env: `MONO_AGENT_ARTIFACT_DIR`.

## Usage & cost tracking (auto)

Each run collects per-turn usage, cost, and cache metrics as events for its JSONL artifact. Pi catalog estimates delegate to Pi's native cost calculation, including request-wide pricing tiers and cache-write rates. Before persistence, non-numeric values under sensitive-looking object keys are redacted; numeric values under matched keys are retained; retained free text is scanned for a closed set of high-confidence credential shapes. The recorder applies a 4,096-byte default cap per string, writes an empty start snapshot, schedules best-effort `running` checkpoints after 25 new events or five seconds from the first uncheckpointed event, and queues the terminal snapshot after any scheduled checkpoint. It replaces the events and summary files separately rather than appending or fsyncing a journal, so a crash can preserve the last successful prefix while losing the unscheduled or failed-write tail. This is automatic (coverage: `auto`) — it rides on the same `artifacts.dir` and needs no separate flag. See [Artifacts & traces](/observability/artifacts-and-traces/) for the complete write-boundary and stale-reconciliation contract.

Related per-turn timing also lands in the JSONL: a `provider_bridge_latency` event separates provider/tool/IO time from harness overhead, and per-tool `tool_timing` events carry `execution_ms`. See [Artifacts & traces](/observability/artifacts-and-traces/) and the [CLI reference](/observability/cli-reference/) for reading these, and [Phoenix & backfill](/observability/phoenix-and-backfill/) to export them as spans.

## Context compaction (Pi bridge-driven, configurable)

Compaction is delegated to the active provider bridge rather than hand-rolled in the runtime. On the pi-native bridge, the bridge drives `AgentHarness.compact()`:

- **Proactively** — before a turn when the running model is near its context window.
- **Reactively** — if a turn still overflows, it compacts and re-prompts once
  only after the rebuilt context preview proves a positive reduction. A
  non-reducing compaction is cancelled before persistence and is not sent back
  to the same model unchanged.

The window auto-tracks whichever model is actually serving the request. Numeric
provider overflow limits become learned ceilings; a generic overflow temporarily
lowers the process-local ceiling to 90% of the failed request estimate. If the
provider metadata is persistently wrong, set `runtime.compaction.contextWindowOverride`.
The runtime still cannot make a malformed model definition, one individually
oversized prompt, or a provider failure compactable; unrecovered overflow remains
an explicit `context_limit` and advances through configured fallbacks.

Every run reports `context_compaction_applied`:

| Value | Meaning |
| --- | --- |
| `true` | Compaction fired this run. |
| `false` | Enabled but not needed. |
| `null` | Compaction disabled (or the bridge does not support it). |

Pi diagnostics also report the full proactive request estimate and fixed
overhead components on every check, plus `context_compaction_reactive_attempted`,
`context_compaction_tokens_after`, and `context_compaction_reduced`. If the
request still exceeds the primary model's window, the run is classified as
`context_limit`; the fallback router may then try the next configured model.

This is automatic and configurable on the pi-native bridge. Defaults resolve
against the effective context window `W`: trigger ratio `0.70`, safety headroom
`clamp(floor(W × 0.25), 16000, 96000)`, retained context
`clamp(floor(W × 0.10), 4000, 20000)`, summary output
`clamp(floor(W × 0.04), 2000, 12000)`, and minimum proactive savings
`clamp(floor(W × 0.10), 4000, 20000)`. Configure overrides under
`runtime.compaction` (or the matching `MONO_AGENT_COMPACTION_*` variables).
Other bridges follow their own compaction behavior. See [Backends](/runtime/backends/) for bridge differences, [Sessions & concurrency](/runtime/sessions-concurrency/) for how sessions persist, and [Fallback](/runtime/fallback/) for window changes across the fallback chain.

## WebFetch retry (auto)

The `WebFetch` tool retries transient network failures (timeout, `ECONNRESET`, 5xx) in-tool with backoff. This keeps the model from burning reasoning rounds re-issuing a fetch that failed for a momentary network reason. It is built into the tool (coverage: `auto`) — there is nothing to configure.

:::tip
This is distinct from provider-transport retries (`providers.piNative.piMaxRetries` / `maxRetryDelayMs`), which retry the model call itself. WebFetch retry is local to the tool's HTTP request. See [Fallback](/runtime/fallback/) for provider-level retry and failover.
:::

## Tool parallelism (code-only)

By default a model step runs its tool calls one at a time. You can opt into running an independent step's tool calls concurrently (pi-agent-core QueueMode), but only programmatically:

```ts
const runtimeOptions = {
  piToolParallelismMode: "all", // default: "one-at-a-time"
};
```

There is no config-file or CLI key for this (coverage: `code`). Enable it only when a step's tools are genuinely independent — concurrent `Write`/`Edit` to the same file, or order-dependent `Bash` commands, will race. See [Programmatic composition](/programmatic/composition/) for where `runtimeOptions` is supplied.

## Coverage at a glance

| Capability | Coverage | How |
| --- | --- | --- |
| Built-in tools | `config` | `tools.allowedTools` / `tools.disallowedTools` |
| Bloat guard (256KB + artifacts) | `auto` | Built in; artifacts to `artifacts.dir` |
| Usage/cost tracking | `auto` | Recorded in JSONL artifacts |
| Context compaction | `config` + `provider` | `runtime.compaction.*`; bridge-driven Pi compaction |
| WebFetch retry | `auto` | Built into the WebFetch tool |
| Tool parallelism | `code` | `runtimeOptions.piToolParallelismMode` |

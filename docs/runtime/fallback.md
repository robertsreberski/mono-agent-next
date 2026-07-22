---
title: "Fallback models & failover"
description: "Configure ordered provider fallback routes, route safety, retry behavior, and readiness checks."
sidebar:
  order: 3
---

`runtime.fallbacks` is the canonical ordered list of backup routes. Each entry
selects a model and, optionally, its exact reasoning effort. The list is not
artificially capped: the router walks it in authored order until one route
succeeds or every eligible route is exhausted. Failover and route-safety history
are reported in results and traces; mono-agent never silently swaps providers.

## Configure canonical routes

```json
{
  "runtime": {
    "model": "pi:openai-codex:gpt-5.6-terra",
    "effort": "high",
    "fallbacks": [
      { "model": "claude:claude-sonnet-5", "effort": "xhigh" },
      { "model": "codex:gpt-5.6-sol", "effort": "high" },
      { "model": "pi:ollama:gemma4:31b" }
    ],
    "routeSafety": "per-route-native"
  }
}
```

The primary uses `runtime.effort`. Every canonical fallback owns its effort:

- An explicit `effort` is forwarded only to that route and must be supported by
  its known model metadata.
- Omitted `effort` means the provider/model default. It does **not** inherit the
  primary's `runtime.effort`.
- Each fallback infers its own execution mode from its model reference; it does
  not inherit `runtime.executionMode` from the primary.

The canonical environment form is JSON:

```bash
export MONO_AGENT_FALLBACKS_JSON='[
  {"model":"claude:claude-sonnet-5","effort":"xhigh"},
  {"model":"pi:ollama:gemma4:31b"}
]'
```

For non-interactive scaffolding, repeat `--fallback` and put an optional
`--fallback-effort` immediately after the route it configures:

```bash
mono-agent init \
  --model pi:openai-codex:gpt-5.6-terra --effort high \
  --fallback claude:claude-sonnet-5 --fallback-effort xhigh \
  --fallback pi:ollama:gemma4:31b --fallback-effort provider-default \
  --route-safety per-route-native
```

## Legacy compatibility

Existing `runtime.fallbackModels` and `MONO_AGENT_FALLBACK_MODELS` remain
supported. Legacy entries retain their historic behavior: they inherit the
global `runtime.effort`. Do not configure canonical and legacy forms together;
choose `runtime.fallbacks` for new agents.

The CLI CSV flag `--fallback-models` was **removed**; it now errors with a
pointer to repeat `--fallback <ref>` instead. That removal covers only the CLI
flag — the JSON and environment compatibility inputs are unaffected. See the
canonical [deprecation tracker](/reference/deprecations/) for the exact scope.

```json
{
  "runtime": {
    "model": "pi:openai-codex:gpt-5.6-terra",
    "effort": "high",
    "fallbackModels": ["pi:ollama:gemma4:31b"]
  }
}
```

## Route safety

`runtime.routeSafety` controls whether every provider must represent one common
safety contract or whether the operator accepts explicit route-local contracts.

| Mode | Contract |
| --- | --- |
| `uniform` (default) | Reuses one monotonic mono-agent tool/sandbox contract. A route that cannot represent a required capability is rejected or skipped before execution. |
| `per-route-native` | Isolates provider runtimes and applies the documented native contract for each attempt. Mixed Pi, Claude, Codex, and OpenCode chains are allowed after explicit review. |

The per-route-native matrix is deliberately concrete:

- **Pi:** mono-agent tool policy, plus managed SRT when configured.
- **Claude:** provider-native sandbox with the tool restrictions the Claude
  bridge can represent; mono-agent SRT is not projected onto the route.
- **Direct Codex:** Codex-native sandbox and exact allow-all at the mono-agent
  tool-policy layer.
- **Direct OpenCode:** provider-native permissions and exact allow-all;
  unsupported capabilities cause the route to be skipped.

Capability-bearing inputs such as MCP, skills, structured output, live input,
or native subagents are never silently removed to make a route pass. Doctor and
runtime checks fail closed or skip that route with `safety_unavailable` /
`skipped_capability_mismatch` and credential-free safety telemetry.

## What failover does

The router advances after retryable provider errors (transport failures, rate
limits, transient server failures), provider-auth failures, and a classified
`context_limit` after the active bridge's compaction recovery is exhausted. A
fallback may have a larger usable window even when the primary cannot reduce its
request further. Quota, output-token, and max-turn failures remain
`usage_limit` and do not become context failover. Successful but undesired output
does not trigger failover. Mid-turn sandbox/safety failures are terminal because
retrying them on another provider could weaken the established contract.

Any configured fallback chain is stateless across provider sessions. The harness
keeps the logical conversation replayable, strips route-owned session ids, and
uses a bounded transcript-tail snapshot when moving between attempts. This avoids
attaching one provider's session token to another provider or accumulating nested
resume blocks across a long chain.

The runtime result includes `failoverHistory` and `routeSafetyHistory`. An
exhausted chain reports `provider_unavailable_exhausted` with per-attempt models,
failure kinds/subkinds, and route safety. Run summaries and Phoenix failover
attributes preserve normalized failover details; the events JSONL preserves the
separate bounded `provider_route_safety` records.

## Guided readiness

Bare interactive `mono-agent init` makes one real, sequential no-tool call for
every selected route. Each route receives its exact configured effort (or provider
default) and its own 90-second cloud / 240-second local deadline. Escape or
Ctrl-C interrupts safely. The recovery menu can:

- resume only routes already verified under the exact non-secret plan
  fingerprint;
- restart all route checks while retaining successful auth and managed SRT;
- edit model choices; or
- cancel without writing.

Changing routes, effort, execution/safety settings, provider configuration,
durable non-secret environment, secret names, Pi auth path, or timeout invalidates
the resume fingerprint. Authentication repair also invalidates every route proof,
even when the non-secret plan is unchanged, because credential bytes may have
changed. A detected credential is not enough: a route becomes verified only
after its exact live check succeeds.

## Ordering and cost

Order routes by preference because the first success wins. A common production
shape is capable cloud primary, lower-cost cloud fallback, then local fallback.
The creation review prints every selected route and effort, the route-safety
matrix, the number of real readiness calls, and how many may be billed before it
asks whether to create the agent.

## Related

- [Multi-model fallback chain](/playbooks/multi-model-fallback-chain/)
- [Backends & execution modes](/runtime/backends/)
- [Execution, effort & permissions](/runtime/execution-effort-permissions/)
- [Sandbox](/tools/sandbox/)
- [Sessions & concurrency](/runtime/sessions-concurrency/)

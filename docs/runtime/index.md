---
title: "Runtimes and routing"
description: "Select one or more native runtime modules and route attempts through explicit runtime and model references."
sidebar:
  order: 0
---

Mono-agent ships four runtime implementations:

| Package | Execution boundary |
| --- | --- |
| `@mono-agent/runtime-pi` | Pi-native provider turns and session linkage. |
| `@mono-agent/runtime-claude` | Claude Agent SDK or explicitly configured Claude CLI. |
| `@mono-agent/runtime-codex` | Codex app-server sessions, approvals, and cancellation. |
| `@mono-agent/runtime-opencode` | Authenticated loopback OpenCode server with bounded native sessions. |

Each selected instance lives in `runtimes.<id>` and names its exact package
through `$use`. Routing references the instance id and a runtime-owned model:

```json
{
  "routing": {
    "primary": { "runtime": "pi", "model": "openai-codex:gpt-5.6-sol" },
    "fallbacks": [
      { "runtime": "claude", "model": "claude-sonnet-4-6" }
    ],
    "effort": "high"
  }
}
```

Core validates references but does not import provider SDKs, discover auth,
rewrite model names, or hide runtime failure. A fallback is eligible only when
the next runtime satisfies the request's capabilities and the prior typed
failure proves no side effects before any committed output or interaction.

A per-turn `runtime`/`model` selection must name one of the configured routes.
An unconfigured selection is rejected at admission on every channel rather than
falling through to the next candidate: silently answering on a different model
and reporting success would contradict the rule that Core advertises model
choices only from strictly validated configured routes. A v0-style
runtime-qualified value such as `"pi:openai-codex:gpt-5.5"` is rejected the same
way.

Authored webhook route frontmatter is validated against these configured routes
during channel start, after route loading and before the HTTP listener binds.
Cron job frontmatter is validated while the trigger module is created, before a
schedule is armed. When one field is omitted, Core resolves it through the
primary route. Telegram applies the same validation before confirming or
storing a non-default `/model` update, so an invalid command preserves the
chat's previous selection.

## Effort keywords

`routing.effort` selects the effort every turn runs at. On top of that, three
opt-in keyword tiers may **raise** the effort for a single message, never lower
it, and never rewrite an unrecognized provider-specific value:

| Tier | Pattern | Raises effort to | Default |
| --- | --- | --- | --- |
| `ultraThink` | `\bultra\s*think\b` (case-insensitive) | `max` | on |
| `extraThink` | `\bextra\s*think\b` (case-insensitive) | `xhigh` | on |
| `think` | `\bthink\b` (case-insensitive) | `high` | **off** |

The strongest matching tier wins regardless of where it sits in the message.

When a tier fires, the run record says so: every attempt of that turn carries
`effortEscalation` with the keyword that matched, the effort it raised to, and
the effort it raised from. `mono-agent` surfaces it through `readRun`, so an
otherwise identical question costing several times more is attributable rather
than mysterious.

`ultra think` and `extra think` are deliberate operator idioms, so they are on by
default. The bare `think` tier is off by default because it matches ordinary
English — "what do you think?", "I think we should use the other approach" — and
raising effort there means more reasoning tokens, higher latency, and higher cost
on turns nobody asked to escalate. Turn it on explicitly if you want it:

```json
{
  "routing": {
    "primary": { "runtime": "pi", "model": "openai-codex:gpt-5.6-sol" },
    "fallbacks": [],
    "effort": "medium",
    "effortKeywords": { "think": true, "extraThink": false }
  }
}
```

Provider sessions belong to the exact conversation/runtime/model route.
Mono-agent does not migrate native v0 sessions; canonical transcript state is the
provider-neutral recovery authority.

## Runtime verification

Every first-party runtime runs the shared behavioral conformance contract
against a real runtime instance and a credential-free provider boundary.
Claude, Codex, and OpenCode run the five-scenario process profile against
protocol-faithful injected processes: completed output, active cancellation,
provider exit, stdin failure, and stderr-backed non-zero exit. Pi runs the
completed and active-cancellation in-process profile through its real
`AgentHarness` and a faux provider; completion includes a real tool-call and
tool-result round trip.

The lane also proves bounded health and diagnostics, secret redaction,
drain/stop transitions, sequential idempotent `stop()` calls, zero active
provider operations after each turn, and zero live provider processes after a
process runtime stops. Negative fixtures prove that each scenario, leak,
report bound, redaction check, and stop assertion fails independently.

The packed system proof executes turns through `@mono-agent/runtime-pi` only.
CI does not provision authenticated Claude, Codex, or OpenCode CLIs, so those
runtime execution guarantees live in their credential-free package
conformance lanes. These fixtures prove adapter behavior and protocol
handling; they do not claim that a real authenticated provider service is
available or healthy.

Use the [package directory](/reference/packages/) for each runtime's exact auth,
configuration, capability, lifecycle, and verification contract.

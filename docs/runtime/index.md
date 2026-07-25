---
title: "Runtimes and routing"
description: "Select one or more native v1 runtime modules and route attempts through explicit runtime and model references."
sidebar:
  order: 0
---

V1 ships four runtime implementations:

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

Provider sessions belong to the exact conversation/runtime/model route. V1
does not migrate native v0 sessions; canonical transcript state is the
provider-neutral recovery authority.

Use the [package directory](/reference/packages/) for each runtime's exact auth,
configuration, capability, lifecycle, and verification contract.

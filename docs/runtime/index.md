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

Provider sessions belong to the exact conversation/runtime/model route. V1
does not migrate native v0 sessions; canonical transcript state is the
provider-neutral recovery authority.

Use the [package directory](/reference/packages/) for each runtime's exact auth,
configuration, capability, lifecycle, and verification contract.

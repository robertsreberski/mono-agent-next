---
title: "Multi-Model Fallback Chain"
description: "Configure ordered model fallbacks and verify how mono-agent advances across unavailable routes."
sidebar:
  order: 13
---

This playbook builds an ordered cloud-to-local fallback chain with exact effort
and explicit provider safety. Failover is visible in results and traces; no model
substitution or safety projection happens silently.

## Who this is for

Reliability-minded builders who want multiple provider families without giving
up an auditable safety contract.

## Features used

- [runtime.multi-backend](/runtime/backends/)
- [runtime.fallback-models](/runtime/fallback/)
- [runtime.effort](/runtime/execution-effort-permissions/)
- [runtime.local-providers](/runtime/local-providers/)

## Configuration

```json
{
  "agent": { "name": "Resilient Research Agent" },
  "runtime": {
    "model": "claude:claude-sonnet-5",
    "effort": "high",
    "fallbacks": [
      { "model": "codex:gpt-5.6-sol", "effort": "xhigh" },
      { "model": "pi:ollama:gemma4:31b" }
    ],
    "routeSafety": "per-route-native"
  },
  "providers": {
    "local": [
      {
        "id": "ollama",
        "type": "ollama",
        "baseUrl": "http://localhost:11434",
        "enabled": true,
        "models": [{ "name": "gemma4:31b" }]
      }
    ],
    "piNative": {
      "transport": "auto",
      "piMaxRetries": 2,
      "maxRetryDelayMs": 60000
    }
  }
}
```

The primary uses `runtime.effort`. The first fallback explicitly uses `xhigh`;
the local route omits effort and therefore uses its provider default. The fallback
list is ordered and has no product-imposed count limit.

`per-route-native` is required here because the chain crosses Claude, Codex, and
Pi contracts. Doctor and guided setup show the matrix before use:

- Claude: provider-native sandbox plus representable tool restrictions.
- Codex: Codex-native sandbox plus exact mono-agent allow-all.
- Pi: mono-agent tool policy and SRT when configured.

If you require one identical mono-agent policy on every attempt, keep the default
`uniform` mode and use only routes that can represent it. Validation fails closed
for an incompatible route.

:::caution
Any configured fallback chain is stateless across provider sessions. The harness
replays logical conversation history and the router uses a bounded transcript-tail
snapshot between attempts, but it never reuses a provider session id across routes.
`providers.piNative.piSessionsRoot` does not turn a mixed fallback chain into a
shared durable provider session.
:::

## Steps

1. Pull the local last resort: `ollama pull gemma4:31b`.
2. Run guided `mono-agent init`, search for each route, and choose the exact
   supported effort per model.
3. Review the default-No per-route-native safety confirmation.
4. Read the **Creation review**: it lists all routes, efforts, provider actions,
   route contracts, and the number of real/potentially billed readiness calls.
5. Let readiness verify each route sequentially. If interrupted, choose resume to
   reuse only successful checks under the unchanged plan fingerprint.
6. Run `mono-agent validate`, then start the agent.
7. Force a retryable provider/auth failure. Confirm the run summary's
   `failoverHistory` identifies failed routes and the events JSONL contains the
   bounded `provider_route_safety` records. Programmatic runtime callers also
   receive `routeSafetyHistory` on the result.

Non-retryable application errors and mid-turn safety failures are not masked by
failover.

## Related

- [Runtime backends](/runtime/backends/)
- [Fallback chain](/runtime/fallback/)
- [Local providers](/runtime/local-providers/)
- [Sessions and concurrency](/runtime/sessions-concurrency/)
- [Config blueprint](/config/blueprint/)

---
title: "Capability ladder"
description: "Choose the lowest v1 ownership boundary that completely satisfies a new capability."
sidebar:
  order: 5
---

Ask what the capability is before adding a package or contract. Use the lowest
rung that completely owns it:

| Order | Desired capability | Correct boundary | Gate |
| --- | --- | --- | --- |
| 1 | Existing behavior or API already fits | Existing package and public surface | No new ownership surface. Use the package's current schema or API. |
| 2 | Model needs instructions for an existing tool or workflow | Selected skill | Keep instructions under `skills/`; do not add host glue. |
| 3 | Model calls a project/domain tool | MCP server in `.mcp.json` | Standard MCP lifecycle, policy, security, and tool-result behavior. No Core or package-catalog edit. |
| 4 | Work runs on a schedule | `@mono-agent/trigger-cron` plus a Markdown job | Typed trigger config, valid runtime/channel references, and bounded job behavior. |
| 5 | External system pushes work | Existing webhook or channel module | Authentication, allowlist, delivery idempotency, bounds, health, and redaction. |
| 6 | Work outlives the turn or independently collects data | External project/host service | Own its durable lifecycle and re-enter through an explicit configured channel or webhook. |
| 7 | New human interface | Product consuming `@mono-agent/operator` | Shared protocol/client/domain fixtures; no second wire decoder or Core import. |
| 8 | Replace a framework runtime, channel, memory, state, trigger, exporter, or sandbox semantic | Narrow typed module | Direct dependency, exact `$use`, package-owned schema, public compliance suite, catalog metadata for first-party modules. A tool inseparable from that selected module may stay with it. |
| 9 | Change an adapter-neutral contract shared by module implementations | `@mono-agent/module-sdk` contract | Last resort and highest blast radius; prove lower rungs cannot own the behavior. |

Package presence never activates a typed module. Project MCP servers do not
become typed modules merely because they are important. Core is not a generic
process supervisor, plugin registry, documentation host, UI toolkit, or service
manager.

The selected-module tool seam does not add a new rung. Use it only when the
behavior is inseparable from an already justified module's private data and
lifecycle, such as state-local's `RunHistory`. Core snapshots the descriptor,
assigns its collision-safe name, applies tool/approval/sandbox policy, and owns
turn-scoped dispatch. Ordinary project and domain tools stay at rung 3 in
`.mcp.json`.

The [v1 architecture](/reference/v1-architecture/) defines dependency direction
and the [package directory](/reference/packages/) names each current owner.

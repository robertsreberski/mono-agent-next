---
title: "Worklab shared kernel decision"
description: "Record why mono-agent and Worklab share agent-runtime as a kernel while remaining separate products."
sidebar:
  order: 60
---

Mono-agent and Worklab should share one runtime kernel: `@mono-agent/agent-runtime`.
Worklab should consume the published runtime package instead of carrying a
vendored runtime fork.

This is an ecosystem decision, not a repository merge. The intended shape is:

- **One shared kernel:** `@mono-agent/agent-runtime` owns provider execution,
  provider sessions, runtime events, Pi-native response generation, and the
  narrow runtime surfaces both products can reuse.
- **Two products:** mono-agent remains the always-on personal-agent framework
  with channels, skills, MCP wiring, optional memory, and config-first
  deployment. Worklab remains the orchestration workbench for tasks, goals, and
  teams.

## Decision

Kill Worklab's runtime fork by moving provider execution onto
`@mono-agent/agent-runtime`. Keep the products separate above that shared
kernel.

Mono-agent can add narrow, additive exports to `@mono-agent/agent-runtime` when
Worklab needs an existing runtime surface that is already part of the package.
For Pi-native response generation, Worklab should use
`generatePiNativeResponse` from `@mono-agent/agent-runtime/ai` rather than a
separate provider subpath or a `pi-sdk` compatibility export.

## Why not merge the repos?

A full mono-agent and Worklab merge is rejected for the current v1 path:

- **License and distribution boundary:** mono-agent and all of its publishable
  packages are `GPL-3.0-only`. Worklab remains a separately deployed product;
  any distribution of the shared kernel must comply with those terms.
- **Package-manager and release-model mismatch:** mono-agent publishes npm
  packages from a pnpm workspace; Worklab's workspace model and deployment needs
  are different.
- **Architecture mismatch:** Worklab is DB-first around tasks, goals, and teams;
  mono-agent is config-first around runtime, channels, skills, and optional
  memory.
- **Momentum mismatch:** Worklab plateaued on June 2, while mono-agent's v1
  issue loop is the active delivery path.

The shared-kernel path gets the important consolidation benefit without forcing
the product, license, deployment, and architecture mismatches into one
monorepo.

## Goal-contract carryover

Mono-agent's goal-contract methodology is adopted for goal tickets. The protocol
in issue #119 is derived from Worklab's proven contract loop: explicit "Done
when" criteria, status checkpoints with evidence, and final disposition of each
contract item.

That methodology should continue in mono-agent even though Worklab remains a
separate product. The operating lesson transfers; the runtime fork does not.

## Consequences

- Worklab depends on `@mono-agent/agent-runtime` for provider execution.
- The shared kernel remains `GPL-3.0-only`, matching the rest of mono-agent's
  publishable package graph and the repository-level `LICENSE`.
- Mono-agent keeps the runtime package as the ecosystem kernel and avoids
  Worklab-specific product concepts in the core runtime.
- Additive runtime exports are acceptable when they expose existing files and do
  not create new compatibility shims.
- No repository merge is required to remove duplicated runtime ownership.

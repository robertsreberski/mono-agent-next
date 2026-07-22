---
title: "Worklab shared kernel decision"
description: "Record the superseded v0 Worklab runtime decision and its disposition under the mono-agent v1 architecture."
sidebar:
  order: 60
---

Status: Superseded for mono-agent v1 by the
[v1 architecture decision](/reference/v1-architecture/).

This decision governed the v0 package shape: mono-agent and Worklab were to
share `@mono-agent/agent-runtime` instead of carrying a vendored runtime fork.
The v1 architecture retires that package and does not make Worklab part of the
v1 migration. Worklab may remain pinned to the final v0 runtime until a
separate, reviewed Worklab migration selects an appropriate v1 runtime or
public contract. Nothing in the v1 refactor preserves `agent-runtime` solely
for Worklab.

The historical intended shape was:

- **One shared kernel:** `@mono-agent/agent-runtime` owns provider execution,
  provider sessions, runtime events, Pi-native response generation, and the
  narrow runtime surfaces both products can reuse.
- **Two products:** mono-agent remains the always-on personal-agent framework
  with channels, skills, MCP wiring, optional memory, and config-first
  deployment. Worklab remains the orchestration workbench for tasks, goals, and
  teams.

## Superseded decision

The v0 decision was to kill Worklab's runtime fork by moving provider execution onto
`@mono-agent/agent-runtime`. Keep the products separate above that shared
kernel.

While Worklab remains on v0, mono-agent v0 can add narrow, additive exports to `@mono-agent/agent-runtime` when
Worklab needs an existing runtime surface that is already part of the package.
For Pi-native response generation, Worklab should use
`generatePiNativeResponse` from `@mono-agent/agent-runtime/ai` rather than a
separate provider subpath or a `pi-sdk` compatibility export.

## Why not merge the repos?

A full mono-agent and Worklab merge is rejected for the current v1 path:

- **License and distribution boundary:** the final-v0 mono-agent graph,
  including `@mono-agent/agent-runtime`, is `GPL-3.0-only`. Worklab remains a
  separately deployed product; any distribution of that v0 kernel must comply
  with those terms. This historical constraint does not override the reviewed
  per-package v1 split.
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

## Current consequences

- Worklab may remain pinned to the predecessor-published registry artifact
  `@mono-agent/agent-runtime@0.16.0`; successor source or packages are not an
  authorized v0 fallback, and this is not a mono-agent v1 dependency or
  retention requirement.
- The final-v0 shared kernel remains `GPL-3.0-only`, matching the final-v0
  publishable package graph and repository-level `LICENSE`; mono-agent v1's
  separately reviewed extension seams follow the v1 licensing decision.
- Mono-agent v1 does not carry Worklab-specific product concepts or a
  compatibility shell for the retiring runtime package.
- Any Worklab move to v1 requires its own consumer evidence, contract choice,
  release plan, and rollback proof.
- No repository merge is required to remove duplicated runtime ownership.

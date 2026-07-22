---
title: "Reference"
description: "Find canonical capability, terminology, compatibility, security, preset, and architecture references."
sidebar:
  order: 0
---

Canonical lookup material for mono-agent: the package directory and capability ladder for finding the right ownership boundary, a scannable capability matrix, a glossary of terms used throughout the docs, the long-form feature registry, and the setup-security contracts intentionally kept out of the runnable Quickstart.

Use this section when you need to confirm an exact config key, env var, or coverage type rather than learn a workflow — for end-to-end recipes see the [playbooks](/playbooks/).

## Pages in this section

| Page | What it gives you |
| --- | --- |
| [Package directory](/reference/packages/) | Every published package, its ownership tier and responsibility, and links to npm and the authoritative package README. |
| [Capability ladder](/reference/capability-ladder/) | Where new capability work belongs before changing package boundaries or shared contracts. |
| [Feature matrix](/reference/feature-matrix/) | Compact, scannable table of capabilities mapped to their primary config key, env var, and coverage type. |
| [Glossary](/reference/glossary/) | Definitions of terms (channel, soul, consolidation, recall, A2A, fallback chain, sandbox, etc.) used across the docs. |
| [Feature registry](/reference/feature-registry/) | Authoritative, long-form checklist — the source of truth a new capability row is added to when a package ships a feature. |
| [Deprecations & compatibility decisions](/reference/deprecations/) | Canonical removal versions and explicit permanent-compatibility decisions for legacy surfaces. |
| [Setup security and managed runtime](/reference/setup-security/) | Low-level guided-secret, managed-runtime, single-instance, and snapshot-integrity guarantees kept out of the runnable Quickstart. |
| [Mono-agent v1 architecture decision](/reference/v1-architecture/) | Accepted v1 ownership, typed-module, repository-lineage, licensing, migration, and complexity decisions. |
| [Worklab shared kernel decision](/reference/worklab-shared-kernel/) | Superseded v0 ecosystem decision: Worklab may remain on `@mono-agent/agent-runtime` while mono-agent v1 retires that package. |

## Coverage types

Every capability in the matrix and registry is tagged with how it is reached. The codes are consistent across all reference pages:

| Code | Meaning |
| --- | --- |
| `config` | Declarable in `mono-agent.config.json`; an env override exists only where the generated reference documents one. |
| `cli` | Reached through a `mono-agent` CLI flag or command. |
| `auto` | Always active when the app runs; needs no declaration. |
| `code` | Available only programmatically — see [Programmatic](/programmatic/). |
| `dev` | A development/testing affordance, not a production runtime feature. |

:::note
If a capability is marked `code` only, it cannot be turned on through `mono-agent.config.json` or the CLI; build it with the SDK as described under [Programmatic composition](/programmatic/composition/).
:::

## How to read a config example

Reference examples use real keys from the [config blueprint](/config/blueprint/). A config field has a matching `MONO_AGENT_*` environment override only when the [generated config reference](/config/reference/) names one; the [environment-variable reference](/config/env-vars/) explains those supported mappings by domain.

```json
{
  "runtime": { "model": "codex:gpt-5.6-terra" }
}
```

The example above sets the primary model; the equivalent override is `MONO_AGENT_MODEL`. For the full annotated file, see the [blueprint](/config/blueprint/).

## Keeping the registry current

:::tip
When a package adds a capability, add a row to the [feature registry](/reference/feature-registry/) (its coverage code, the config key/env var, and the CLI command if any), then mirror the summary into the [feature matrix](/reference/feature-matrix/). The registry is the upstream source; the matrix is its scannable projection.
:::

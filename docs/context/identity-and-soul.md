---
title: "Identity & soul"
description: "Configure an agent's required identity, optional public name, and optional soul guardrails."
sidebar:
  order: 1
---

Three separate surfaces describe an agent: the optional public `agent.name`, a **required identity** markdown document that declares role and boundaries, and an optional **soul** document that carries voice and guardrails. The public name is display metadata; the markdown files are what shape prompt behavior.

Both are part of the assembled context block. For how they sit alongside memory and skills, see [Context assembly](/context/assembly/).

## At a glance

| Field | Required | Env var | Renders as | Coverage |
| --- | --- | --- | --- | --- |
| `agent.name` | No | `MONO_AGENT_NAME` | Human-facing label only | `config` |
| `context.identityPath` | Yes | `MONO_AGENT_IDENTITY_PATH` | `## Identity` section | `config` |
| `context.soulPath` | No | `MONO_AGENT_SOUL_PATH` | `## Core Guardrails` section | `config` |

`context.identityPath` is one of only two fields that are never optional (the other is `runtime.model`). Omit `context.soulPath` and the framework substitutes a built-in default soul — see [Default soul fallback](#default-soul-fallback).

## Public agent name

`agent.name` is chosen during guided init and shown in creation review, traces,
and other human-facing labels. The A2A adapter also uses it as the default Agent
Card name when its plugin-specific name is omitted. It never alters filesystem
paths, service/source ids, provider identity, or session keys. The config field is
not injected into prompts at runtime. Guided init copies the chosen name only into
a newly scaffolded, editable `IDENTITY.md`; later `agent.name` changes do not
rewrite that file, and an existing identity is never overwritten.

```json
{
  "agent": { "name": "Research Companion" },
  "context": { "identityPath": "./IDENTITY.md" }
}
```

## Identity (required)

`context.identityPath` points at the markdown loaded into **every** prompt. It defines the agent's role, scope, and hard boundaries. `mono-agent init` scaffolds an `IDENTITY.md` for you.

During guided init, the Role prompt and Creation review both name the single canonical destination: `IDENTITY.md` → `## Role`. In a new file, the accepted Role text becomes that section's body without paraphrasing. The post-create summary repeats where to edit it later. If `IDENTITY.md` already exists, init preserves it byte-for-byte, reports that the entered Role was not written, and tells you to add or edit its `## Role` section. It never assumes a pre-existing identity already has that heading, and it never stores the unused answer in config or a second identity location.

```json
{
  "context": {
    "identityPath": "./IDENTITY.md"
  }
}
```

Override the path without editing config:

```bash
MONO_AGENT_IDENTITY_PATH=/etc/mono-agent/IDENTITY.md mono-agent start
```

### Reference, don't duplicate

The identity document should be short and stable. Rather than copy-pasting project knowledge into it, **reference the knowledge files the agent already reads** — `AGENTS.md`, `CLAUDE.md`, `README.md`, and similar — so there is a single source of truth.

```markdown
# Identity

You are the build-and-release agent for the `acme-web` repo.

## Role

- Triage failing CI, propose fixes, and open PRs against `main`.
- Stay inside the repo working tree; never touch infra or secrets.

## Knowledge

Authoritative project guidance (read before acting):
- ./AGENTS.md — contribution rules and review gates
- ./CLAUDE.md — codebase conventions and commands
- ./README.md — what the service does and how to run it
```

:::tip
Duplicating those files into the identity invites drift: when `CLAUDE.md` changes, your identity silently goes stale. A pointer stays correct.
:::

## Soul (optional)

`context.soulPath` is a secondary document for **voice, tone, and guardrails** — the "how it behaves" layer that complements the "what it is" identity. It renders as the `## Core Guardrails` section of the prompt.

```json
{
  "context": {
    "identityPath": "./IDENTITY.md",
    "soulPath": "./SOUL.md"
  }
}
```

```bash
MONO_AGENT_SOUL_PATH=/etc/mono-agent/SOUL.md mono-agent start
```

Use the soul for cross-cutting behavior that is not tied to any one task: how to handle uncertainty, how to surface failures, what never to fake, and how to leave handoff notes.

## How they render

The assembled prompt places the soul first, then the identity:

```text
## Core Guardrails
<contents of soulPath, or the built-in default soul>

## Identity
<contents of identityPath>
```

Both blocks are passed through verbatim, subject to the per-section size handling described in [Context assembly](/context/assembly/).

## Default soul fallback

When `context.soulPath` is **omitted**, the `## Core Guardrails` section is filled with a built-in default soul — a conservative, source-grounded baseline (follow the instruction hierarchy, read before acting, keep scope small and reversible, preserve secrets, do not fake success, surface failures honestly, ask when unsure, leave handoff notes).

The default soul also carries a capability-agnostic recall guardrail:

> Before assuming a fact or asking the user, first check the provided context and any available recall/search tools for the information.

This nudges the agent to consult what it already has — the prompt context and any enabled recall/search tools — before guessing or asking, without implying a specific tool exists. It pairs with the strengthened [`MemoryRecall` tool description](/tools/mcp/), which directs proactive recall when context is missing or uncertain. If you supply your own `soulPath`, consider keeping an equivalent line so a memory-enabled agent actually reaches for [recall](/memory/capture-and-recall/).

:::note
The fallback is **the default soul text, not your identity**. Leaving out `soulPath` does not duplicate the identity into the guardrails section — it inserts the framework default instead. Set `context.soulPath` only when you want to replace that baseline.
:::

## Related

- [Skills](/context/skills/) — selecting per-skill capability docs into context
- [Context assembly](/context/assembly/) — full order and sizing of the prompt context
- [Config blueprint](/config/blueprint/) — the annotated `mono-agent.config.json`
- [Environment variables](/config/env-vars/) — every `MONO_AGENT_*` override

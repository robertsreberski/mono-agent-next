---
title: "Selected skills"
description: "Load explicit SKILL.md instruction sets into agent context with ordered selection and byte limits."
sidebar:
  order: 2
---

mono-agent loads skills the way it loads identity and soul: explicitly. You name the skills you want, and each is read from `<skillsRoot>/<name>/SKILL.md` and folded into the assembled context. There is **no auto-selection, ranking, or fuzzy matching** — the set you list is the set the agent gets, in order. This page covers `context.skillsRoot`, `context.selectedSkills`, the per-skill byte cap, and how the bundled `mono-agent-composer` skill itself is installed or reused.

For how skills sit alongside identity/soul/memory in the final prompt, see [Context assembly](/context/assembly/).

## How selection works

Skills are a `config`-coverage feature. You set a root directory and a list of exact names:

```json
{
  "context": {
    "skillsRoot": "./skills",
    "selectedSkills": ["research", "incident-response"],
    "skillMaxBytes": 48000
  }
}
```

For each entry `name` in `selectedSkills`, mono-agent reads `<skillsRoot>/<name>/SKILL.md`. With the config above it loads `./skills/research/SKILL.md` and `./skills/incident-response/SKILL.md`. Names must match the directory exactly — there is no discovery of skills you did not list, and a missing `SKILL.md` surfaces as a load error rather than being silently skipped.

| Key | Purpose | Default | Env var |
| --- | --- | --- | --- |
| `context.skillsRoot` | Directory that contains one subdirectory per skill | — | `MONO_AGENT_SKILLS_ROOT` |
| `context.selectedSkills` | Exact skill names to load (each `<root>/<name>/SKILL.md`) | `[]` at loader level; init selects the two project skills | `MONO_AGENT_SELECTED_SKILLS` |
| `context.skillMaxBytes` | Per-skill instruction byte cap | `48000` | `MONO_AGENT_SKILL_MAX_BYTES` |
| `context.skillDisclosure` | `index` exposes names plus `ReadSkill`; `full` inlines every selected body | `full`; generated agents use `index` | `MONO_AGENT_SKILL_DISCLOSURE` |

`MONO_AGENT_SELECTED_SKILLS` is a comma-separated list, e.g. `MONO_AGENT_SELECTED_SKILLS=research,incident-response`.

The folder convention is part of the standard [agent folder layout](/config/folder-layout/): an optional `skills/` directory holding `<skill-name>/SKILL.md` per selected skill.

## Skills generated with every agent

`mono-agent init` creates and selects two versioned project-local skills:

- `mono-agent-configure` guides the fail-closed low-risk proposal allowlist and hands paths, tiers/capture, secrets, providers, channels, plugins, MCP, sandbox/network, exporters, and unknown fields to explicit guided setup.
- `mono-agent-memory` explains the built-in memory tiers, prerequisites, and cost/quality tradeoffs.

Generated agents use `skillDisclosure: "index"`, so their names/descriptions enter the prompt while the bodies load on demand through `ReadSkill`. `ReadSkill` is shown separately from action-tool allowlists because disabling file/shell/web actions does not disable skill disclosure.

In index mode, the model-facing Skill Index contains names and descriptions but not filesystem paths to each `SKILL.md`. The prompt tells the agent to call `ReadSkill` with the selected name before following that skill; ordinary `Read` remains available for supporting files referenced by the loaded instructions. Skill paths remain in host-side context metadata for diagnostics.

The file `skills/.mono-agent-managed.json` records the installed version and SHA-256 of each managed copy. Check drift without writing, or update only unchanged managed copies:

```bash
mono-agent install-skill --project --check
mono-agent install-skill --project --update
```

Update writes atomically and retains the previous managed files under `skills/.mono-agent-backups/`. A missing or stale unchanged copy can be repaired; an operator-modified or colliding copy is never overwritten and requires manual reconciliation. `mono-agent validate` reports managed drift.

## The per-skill byte cap

`context.skillMaxBytes` bounds how many bytes of each skill body are injected, so a large `SKILL.md` cannot blow out the context window. The default is **48000**; the accepted range is **256 to 1,000,000** bytes.

Truncation is UTF-8-safe: the body is cut at the cap without splitting a multi-byte character, so you never get a corrupted final glyph. The cap applies per skill, not to the combined total — three selected skills can each contribute up to `skillMaxBytes`.

:::tip
Keep each `SKILL.md` well under the cap. If a skill is being truncated, that is a sign its body is too long for an always-on instruction — move the detail into reference files the agent reads on demand rather than relying on it being present every turn.
:::

## Installing the bundled composer skill

mono-agent ships a `mono-agent-composer` skill — the one that knows how to scaffold, validate, and start an agent from a single `mono-agent.config.json`. There are two ways to put it to work.

### Into a coding harness (`cli` coverage)

To make the composer available to Claude Code or Codex on your machine, copy it into the harness skills directory with the CLI:

```bash
mono-agent install-skill --target both
```

`--target` accepts `claude`, `codex`, or `both` (default: `both`). It copies the skill into `~/.claude/skills` and/or `~/.agents/skills`. By default it also pairs the matching `@mono-agent/docs-mcp` version with every selected harness CLI that is available, giving the composer semantic and exact-identifier search over its references and the public documentation. The command refuses to overwrite an existing skill destination unless you pass `--force`:

```bash
mono-agent install-skill --target claude --force
```

Pass `--no-docs-mcp` to install only the skill. That opt-out does not remove an
existing server entry. Unknown MCP configuration using the reserved
`mono-agent-docs` name is never overwritten, including under `--force`, and
project-skill `--check` / `--update` mode never touches harness MCP settings. See
[Documentation MCP companion](/tools/documentation-mcp/) for the search contract,
manual registration, and diagnostics.

This is for *authoring* agents from your IDE/CLI — it is unrelated to what a running agent loads at turn time.

### As a selected skill for your agent

If you instead want a running agent to have the composer's knowledge in its own context, treat it like any other selected skill: point `skillsRoot` at the package's bundled skills directory and select it by name.

```json
{
  "context": {
    "skillsRoot": "packages/agent-app/skills",
    "selectedSkills": ["mono-agent-composer"]
  }
}
```

That loads `packages/agent-app/skills/mono-agent-composer/SKILL.md`. Use the path to wherever the `@mono-agent/agent-app` package is resolved in your project.

## Skills are not tools

:::note
A selected skill is *instruction text* added to the prompt — it shapes how the agent reasons and which workflows it follows. It does not, by itself, grant the agent any new capabilities to execute. Tool availability is governed separately by the [tool policy](/tools/policy/) and [MCP servers](/tools/mcp/). A skill can tell the agent to use a tool, but the tool must also be allowed.
:::

## Programmatic use

The selection model above is the supported `config` surface. If you are composing the context layer in code rather than via `mono-agent.config.json`, the same `skillsRoot` / `selectedSkills` / `skillMaxBytes` inputs are wired through the host — see [Programmatic composition](/programmatic/composition/).

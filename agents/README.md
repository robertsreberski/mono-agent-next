# Engineering agent templates (for developing mono-agent itself)

These are **project-level subagent definitions** for Claude Code / Codex
sessions working on this repository. They are loaded via the `.claude/agents`
and `.codex/agents` symlinks at the repo root.

They are **NOT agent configs for mono-agent runtime instances** — live agents
are configured by `mono-agent.config.json` in their own folders, not by these
files. Repository-wide engineering rules remain in [`AGENTS.md`](../AGENTS.md).

## File layout

Each agent has two companion files with the same stem:

- `<name>.md` — Claude-style Markdown/YAML template.
- `<name>.toml` — Codex custom-agent config with `name`, `description`,
  `developer_instructions`, and `model_reasoning_effort`.

The Markdown file owns the reusable instructions. The TOML file makes the same
agent discoverable to Codex; keep both representations synchronized. Run
`pnpm run check:codex-discoverability` after changing either one.

## Available templates

The templates were designed from real development-session history (June–July
2026). The dominant observed workflow was adversarial review (thousands of
reviewer subagent sessions reading full files and diffing against merge-base),
followed by the single-package build/test/typecheck loop, worktree-isolated
feature work, live smoke testing, docs sync, and lockstep releases — each
template encodes the corresponding discipline.

| Agent | Role | Codex effort |
|---|---|---|
| `implementer` | Repo-disciplined feature/fix implementation (TDD, worktree, capability ladder) | high |
| `adversarial-reviewer` | Defect-hunting review loops until a clean round; read-only | high |
| `live-smoke-operator` | Drives throwaway-agent / tmux TUI / web curl smoke, reports with evidence | medium |
| `docs-curator` | Docs + website sync and PR-range audits | medium |
| `release-engineer` | Lockstep release preflight, tag, CI watch, post-verify | high |

Select the narrowest template that owns the requested outcome. Runtime-agent
composition belongs in an agent folder or the
[`create-mono-agent`](../packages/create-mono-agent/README.md) scaffolder
instead.

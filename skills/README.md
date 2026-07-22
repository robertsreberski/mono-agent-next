# Engineering skills (for developing mono-agent itself)

These are **project-level engineering skills** for Claude Code / Codex sessions
working on this repository. They are loaded via the `.claude/skills` and
`.agents/skills` symlinks at the repo root.

Each skill also carries `agents/openai.yaml` metadata so Codex can show concise
UI labels, descriptions, and default prompts while keeping `SKILL.md` as the
agent-facing workflow.

They are **NOT runtime skills for mono-agent instances** — those live in each
agent's own folder (e.g. `~/personal-agent/skills/`) and are selected via
`context.selectedSkills` in `mono-agent.config.json`.

## File layout

Each directory is one engineering workflow. `SKILL.md` is its authoritative
instruction surface; `agents/openai.yaml` provides discoverability metadata.
Supporting scripts, templates, or references stay inside that skill directory
and should be loaded only when its `SKILL.md` routes the task there. Run
`pnpm run check:codex-discoverability` after changing a skill or its metadata.

## Selection rule

Choose one primary skill from the requested outcome. Use a second skill only
when the request explicitly crosses that boundary. In particular:

- `release-lockstep` ends at public-registry verification; it does not imply a deploy.
- `fleet-deploy` operates only on named consumers; it does not imply a fleet-wide audit.
- `live-smoke` runs one scenario matching the changed surface, not every scenario.
- `docs-sync` checks only documentation surfaces affected by the diff.
- `repo-hygiene-gc` is an explicit bulk-maintenance workflow; normal PR cleanup stays in `worktree-feature`.

`verify-green` is the shared lane selector. A docs/skills/process diff does not
build the monorepo. Ordinary code gets focused checks plus one broad CI gate.
Only high-risk runtime changes add a local full gate and one live smoke.

## Available skills

| Skill | Use when |
|---|---|
| `verify-green` | Select and run the smallest risk-appropriate verification lane |
| `worktree-feature` | Isolated feature work with diff-aware setup and safe cleanup |
| `fleet-deploy` | Restart or deploy only the explicitly requested live consumers |
| `live-smoke` | Run one real end-to-end scenario matching the changed surface |
| `release-lockstep` | Cut and registry-verify a lockstep npm release; no implicit deploy |
| `docs-sync` | Update and verify only documentation surfaces affected by a change |
| `pi-upstream-recon` | Reading vendored pi source before building; pi bumps |
| `new-package` | Adding a package that passes `check:architecture` first try |
| `dead-code-audit` | Prove-or-remove sweeps: dead exports, orphaned wiring, deprecation removability |
| `repo-hygiene-gc` | Explicit bulk branch/worktree GC with API-bound deletion proof |
| `ops-log-hygiene` | Targeted post-restart log checks or an explicitly requested full audit |

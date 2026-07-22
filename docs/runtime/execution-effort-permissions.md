---
title: "Execution mode, effort & permissions"
description: "Configure SDK or CLI execution, reasoning effort, permission posture, turn limits, and workspace scope."
sidebar:
  order: 2
---

This page covers the `runtime.*` knobs that shape *how* a run executes once a backend is selected: whether the model runs through an in-process SDK or a CLI subprocess, how much reasoning effort it spends, how tool permissions are posed, and how many turns a run may take. All of these are `config` coverage (set in `mono-agent.config.json`) with a matching `MONO_AGENT_*` environment override. For *which* backend each model string maps to, see [Backends](/runtime/backends/).

A representative runtime block:

```json
{
  "runtime": {
    "model": "pi:openai-codex:gpt-5.6-terra",
    "executionMode": "sdk",
    "effort": "medium",
    "permissionMode": "default",
    "maxTurns": 0,
    "workspace": "."
  }
}
```

## Execution mode

`runtime.executionMode` selects how the model is driven: `sdk` runs the provider in-process; `cli` shells out to a vendor CLI subprocess (Claude Code / Codex / OpenCode). When omitted, the mode is **inferred from the model string**: `codex:*` and `opencode:*` references default to `cli`, everything else (including `claude:*` and `pi:<provider>:<model>`) defaults to `sdk`. Set it explicitly only to override that inference.

| Key | Values | Default | Env var |
|-----|--------|---------|---------|
| `runtime.executionMode` | `sdk` \| `cli` | inferred (codex/opencode → `cli`, else `sdk`) | `MONO_AGENT_EXECUTION_MODE` |

Several other features key off the backend implied by execution mode — most notably `permissionMode` (CLI-only, below). When wiring a model into `memory.llm`, the same `executionMode` field applies there; see [Capture & recall](/memory/capture-and-recall/).

## Effort

`runtime.effort` is the primary route's reasoning-effort hint. Canonical `runtime.fallbacks[]` entries have independent optional effort; omission means that route's provider default rather than inheritance from the primary. Higher effort trades latency and token cost for deeper reasoning. The wizard offers only the effort values advertised for the selected model plus **Provider default**. The direct OpenCode bridge exposes no reasoning-effort input, so any explicit effort on that route is rejected before provider startup; `pi:opencode-go:*` remains a normal Pi effort path.

| Key | Values | Default | Env var |
|-----|--------|---------|---------|
| `runtime.effort` | `none` \| `minimal` \| `low` \| `medium` \| `high` \| `xhigh` \| `max` \| `ultra` | provider/model default when omitted | `MONO_AGENT_EFFORT` |

`ultra` is route-specific. Reasoning-capable `pi:*` maps `ultra` to LOW; Pi
without reasoning uses OFF. Direct `codex:*` forwards `ultra` unchanged.
Mono-agent rejects `ultra` on its Claude SDK route because the pinned SDK public
contract ends at `max` (the SDK JavaScript itself forwards the value). The
Claude CLI route passes `--effort ultra`, but both tested Claude Code binaries
(SDK-bundled 2.1.206 and local 2.1.210) warn that it is unknown, ignore it, and
use default effort. Direct OpenCode rejects explicit effort. `effortRank`
places `ultra` above `max` only so keyword escalation cannot downgrade an
explicitly configured value.

```json
{ "runtime": { "model": "pi:openai-codex:gpt-5.6-terra", "effort": "high" } }
```

```json
{
  "runtime": {
    "model": "pi:openai-codex:gpt-5.6-terra",
    "effort": "high",
    "fallbacks": [
      { "model": "codex:gpt-5.6-sol", "effort": "xhigh" },
      { "model": "pi:ollama:gemma4:31b" }
    ]
  }
}
```

### Per-turn keyword escalation

Every inbound message is scanned for effort trigger phrases, always on with no configuration:

| Phrase | Effort |
|--------|--------|
| `think` | `high` |
| `extra think` / `extrathink` | `xhigh` |
| `ultra think` / `ultrathink` | `max` |

Matching is case-insensitive on word boundaries anywhere in the message ("what do you *think*?" triggers; "thinking" and "rethink" do not), and the strongest matching phrase wins. Escalation is one-directional: the turn runs at the **higher** of the otherwise-resolved effort (configured default or a per-trigger override) and the keyword's level, so a bare `think` never lowers a `xhigh` agent and an equal-or-lower keyword changes nothing. The trigger words stay in the message text.

`max` degrades gracefully to each route's ceiling — Pi preserves native `max` when the resolved model advertises it and otherwise clamps to `xhigh`; direct Codex clamps to `xhigh`; Claude keeps native `max`. A direct OpenCode model anywhere in the effective chain skips escalation entirely (no runtime effort control, same rule as explicit effort overrides). The escalated effort is visible in the run's `run_config` event with `overridden: true`, and only the single turn is affected — the session and configured default stay unchanged. The trigger list is exported as `EFFORT_KEYWORD_TRIGGERS` from `@mono-agent/config`.

## Permission mode

`runtime.permissionMode` sets the tool-permission posture for **CLI backends only** (Claude Code / Codex / OpenCode). It mirrors the underlying CLI's permission flags and has no effect on `sdk` execution mode.

| Value | Meaning |
|-------|---------|
| `default` | Normal interactive permission prompts |
| `plan` | Planning posture — the model proposes without executing edits/commands |
| `acceptEdits` | Auto-accept file edits |
| `bypassPermissions` | Bypass permission prompts entirely |

| Key | Values | Default | Env var |
|-----|--------|---------|---------|
| `runtime.permissionMode` | `default` \| `plan` \| `acceptEdits` \| `bypassPermissions` | `default` | `MONO_AGENT_PERMISSION_MODE` |

`permissionMode` is the *config-level* posture. Programmatic human-in-the-loop approval gates (risk tiers, timeout, always-allow lists) are a separate, **code-only** mechanism on `createMonoRuntime({ onToolApprovalRequest, toolRiskTiers, approvalDefaultRiskTier, approvalTimeoutMs, approvalAlwaysAllowTools })` that requires a host UI to answer prompts — see [programmatic approval & structured output](/programmatic/approval-and-structured-output/). For limiting *which* tools exist at all, use the tool policy in [Tools & guards](/runtime/tools-and-guards/) and [Tool policy](/tools/policy/).

Direct `codex:*` normal runs currently support only exact allow-all at the mono-agent tool-policy layer (`tools.allowedTools: ["*"]` with no `disallowedTools`, or an omitted allowlist). Unattended direct-Codex turns always use approval policy `never`: `plan` is read-only, `default`/`acceptEdits` use Codex's native workspace-write sandbox, and `bypassPermissions` explicitly selects danger-full-access. Uniform route safety rejects a mono-agent SRT policy that Codex cannot represent; explicit per-route-native routing records that the Codex attempt uses its native contract instead. Choose Pi when exact SRT controls must apply to every route. The guided route check is a dedicated read-only/no-approval/no-tool probe and is not a reusable normal-run policy.

Direct `opencode:*` also requires exact allow-all, but projects `permissionMode`
into OpenCode's native permission rules and replies rather than pretending the
mono-agent sandbox applies:

- `plan` allows native file reads while denying edits and all other permissions. This is a read-only workflow posture, **not a confidentiality boundary**: OpenCode's path rules follow symlinks, so a permitted path can still expose sensitive content through an alias.
- `default` asks through a programmatic `onToolApprovalRequest` callback for reads and other supported permission names, and rejects when no callback answers.
- `acceptEdits` uses the same baseline as `default` and additionally permits edits.
- `bypassPermissions` permits non-interactive permission classes without asking.

Direct OpenCode always denies `question`, `task`, `plan_enter`, and `plan_exit`
because this bridge has no live-question or native-subagent event path. Dynamic
permission names from MCP/custom tools are valid, but in `default` and
`acceptEdits` they require an explicit host approval and reject unattended.
Callback errors, timeouts, malformed permission events, and invalid answers also
reject. `pi:opencode-go:*` is a Pi SDK route and uses Pi's tool/sandbox contract
instead.

Every direct-OpenCode run starts a password-authenticated loopback server on an
ephemeral port with a unique private database (0700 parent / 0600 file). The
database is deleted after the server closes, so direct OpenCode does not resume
provider sessions and never imports the user's sessions or saved approvals.
Repo/global config and external plugins/skills are disabled; provider-owned shell
tools inherit only a narrow non-secret environment. Built-in providers use the
normal OpenCode auth store so refresh-token rotation persists.
`OPENCODE_AUTH_CONTENT` is rejected; persist credentials with `opencode auth
login`. A host `always` approval is cached only for the current mono-agent run:
the provider receives `once`, so project-wide approval state is never saved.
Stable OpenCode CLI >=1.15.0 and a native database migration marker are required;
run `opencode db migrate --pure` once before first use.

Use Pi with the mono-agent native `srt` sandbox when secrets or filesystem roots
must be enforced; direct OpenCode permission rules do not provide that boundary.

:::caution
`permissionMode: "bypassPermissions"` removes interactive guardrails. On Pi, pair a powerful tool surface with the [sandbox](/tools/sandbox/) filesystem scopes. Direct Codex maps bypass mode to danger-full-access and rejects mono-agent `srt`; Claude and direct OpenCode likewise cannot enforce mono-agent `srt` around provider-owned tools. Use Pi (including `pi:opencode-go:*`) when exact mono-agent roots, deny-write globs, or network policy are required.
:::

## Max turns

`runtime.maxTurns` caps the number of turns a single run may take. `0` (or omitting the key) means **unlimited**; values `1`–`100` cap supported runtimes. Direct OpenCode rejects every positive value because its current bridge has no enforceable hard turn cap; use `0`/omit the field or choose another runtime.

| Key | Values | Default | Env var |
|-----|--------|---------|---------|
| `runtime.maxTurns` | `0` (unlimited) \| `1`–`100` | `0` | `MONO_AGENT_MAX_TURNS` |

This value does not size conversation history. The configured app uses an owner-only, disk-backed 64-message history window for each exact conversation id regardless of whether `maxTurns` is positive, `0`, or omitted (`auto` coverage). Aggregate defaults are 256 MiB, 10,000 conversations, and 365 days of inactivity; publication is atomic and retention runs only after commit. A custom history store is available via code (`createConfiguredAgentResponder({ historyStore })`). See [Sessions & concurrency](/runtime/sessions-concurrency/).

```json
{ "runtime": { "model": "codex:gpt-5.6-terra", "maxTurns": 12 } }
```

## Workspace

`runtime.workspace` is the working directory for runtime tools (file reads/writes, shell, etc.). Relative paths resolve against the config directory; the default is `"."`.

| Key | Values | Default | Env var |
|-----|--------|---------|---------|
| `runtime.workspace` | path string | `"."` | `MONO_AGENT_WORKSPACE` |

The workspace is also the default root for sandbox filesystem scopes — `sandbox.readableRoots` / `sandbox.writableRoots` relative entries resolve against it, and `.env*`, `.git/config`, and `.git/hooks/**` are denied for writes by default. See [Sandbox](/tools/sandbox/). For the on-disk layout around the workspace, see [Folder layout](/config/folder-layout/).

## Quick reference

| Key | Env var | Default | Coverage |
|-----|---------|---------|----------|
| `runtime.executionMode` | `MONO_AGENT_EXECUTION_MODE` | inferred from model | config |
| `runtime.effort` | `MONO_AGENT_EFFORT` | unset (provider/model default) | config |
| `runtime.permissionMode` | `MONO_AGENT_PERMISSION_MODE` | `default` (CLI only) | config |
| `runtime.maxTurns` | `MONO_AGENT_MAX_TURNS` | `0` (unlimited) | config |
| `runtime.workspace` | `MONO_AGENT_WORKSPACE` | `"."` | config |

See also: [Backends](/runtime/backends/) · [Fallback chain](/runtime/fallback/) · [Sessions & concurrency](/runtime/sessions-concurrency/) · [Config blueprint](/config/blueprint/) · [Environment variables](/config/env-vars/).

---
title: "Tool policy"
description: "Allow or deny built-in and app-owned tools while keeping external MCP server boundaries explicit."
sidebar:
  order: 1
---

The tool policy decides which tools an agent may call — built-in tools (Read, Bash, …) and policy-gated app-owned MCP tools such as `RunHistory` and adapter send tools. It is **allow-all by default**: an agent with no `tools` block gets every policy-gated tool, and you subtract from there. You declare it under `tools.allowedTools` / `tools.disallowedTools` (coverage: `config`), with deny always winning and overlaps rejected up front. External MCP-server tools use server declaration as their boundary instead.

## Allow-all by default

If you set no `tools` block, or omit `allowedTools`, the agent can call **every** built-in, `RunHistory` on a compatible route, and every enabled channel's send tools. There is no allowlist to curate before an agent can do anything — you start open and remove what you don't want. `allowedTools` accepts four shapes:

| `tools.allowedTools` | Result |
| --- | --- |
| omitted | **all tools** (the default) |
| `["*"]` | all tools (explicit allow-all) |
| `["Read", "Bash"]` | just those tools |
| `[]` | **no tools** — a deliberate chat-only agent |

```json
{
  "tools": {
    "allowedTools": ["*"]
  }
}
```

An explicit empty list is still expressible and still meaningful: `"allowedTools": []` means the agent can hold a conversation but cannot read files, run commands, or send proactively. [`validate` / `doctor`](/observability/cli-reference/#validate) reports that as `waiting` (never a silent `ok`) so an accidental empty list surfaces, while allow-all reports `All tools allowed.`

In guided init, **Allow all tools** remains the default product choice. Pi/Claude flows explicitly name the resulting code-execution, file, web, and enabled channel-send surface before accepting it. If no enforceable sandbox constrains that runtime, a second confirmation is required before continuing; the review never presents allow-all as a risk-free default. Direct Codex skips the tool and mono-srt prompts because normal runs require exact allow-all and use the Codex-native network-off workspace sandbox.

:::note
Allow-all is the **config** default, not a programmatic one. For code-defined agents built directly on `@mono-agent/agent-harness`, the no-config safety net is the opposite: `failClosedToolPolicy()` returns `{ allowedTools: [], disallowedTools: [] }` — an empty, fail-closed policy — so a harness constructed with no policy starts with zero tools until you pass one. The allow-all default lives in the config loader, not the harness.
:::

:::caution
**Enforcement varies by runtime.** Unsupported combinations fail before provider startup instead of silently widening the tool surface.

- **pi-native** — both guarantees hold: `[]` is a true chat-only agent, and a specific list is the agent's complete tool surface.
- **Claude SDK** — both guarantees hold through the SDK's native tool options.
- **Claude Code** CLI — a specific non-empty list is passed as `--tools` and restricts the surface; `disallowedTools` reaches the native denylist. An explicit `[]` cannot represent chat-only in that CLI and is therefore rejected by validation and runtime before spawn.
- **Codex** CLI — the app-server cannot enforce arbitrary mono-agent name lists. Normal direct `codex:*` runs are accepted only with exact allow-all (`["*"]` or omitted, with no `disallowedTools`). A specific list, `[]`, or any denylist fails validation and runtime startup with a capability mismatch; mono-agent never silently widens it. Choose another runtime for a restrictive policy.
- **Direct OpenCode** — the app-server bridge likewise requires exact allow-all (`["*"]` or omitted, with no `disallowedTools`). Restrictive policies fail validation and runtime before the OpenCode server is created. `pi:opencode-go:*` is a Pi runtime and supports Pi's full policy instead.

The guided direct-Codex route check is not an exception operators can reuse: it is a dedicated internal contract with a read-only sandbox, approval policy `never`, no MCP/dynamic tools, a disposable session, and interruption/failure on the first tool-action event.
:::

## allowedTools / disallowedTools

| Key | Type | Behavior |
| --- | --- | --- |
| `tools.allowedTools` | `string[]` | The allowlist. Omitted or `["*"]` means all tools; a specific list narrows to those names; `[]` means none. |
| `tools.disallowedTools` | `string[]` | The denylist. Tools named here are always blocked, even under allow-all. |

Two rules govern how the lists combine:

- **Deny wins.** A tool in `disallowedTools` is blocked regardless of anything else — including allow-all. `disallowedTools` is how you subtract a single tool from the open default without switching to an explicit allowlist.
- **Overlap is rejected, not resolved.** If the same tool name appears in *both* lists, agent creation fails with an `invalid_tool_policy` error (`"Tools cannot be both allowed and disallowed."`) reporting the overlapping names. The policy is not silently reconciled — you must fix the config.

Each list must contain unique, non-empty strings; duplicate names within a single list also raise `invalid_tool_policy`. Name matching is case-insensitive for duplicate detection.

```json
{
  "tools": {
    "disallowedTools": ["Bash"]
  }
}
```

:::note
The example above keeps allow-all (every tool stays available) but denies `Bash` — the agent can read, edit, fetch, and send, just not run shell commands. To go the other way and hand-pick a minimal surface, list the exact names in `allowedTools` instead.
:::

## Deny enforcement by runtime

`disallowedTools` filters the built-in tools (`Read`, `Bash`, …), the progressive-disclosure `ReadSkill` tool, `RunHistory`, and app-owned adapter send tools (`SlackSendMessage`, `TelegramSendMessage`, …) on runtimes that expose those tools through mono-agent. The **Claude Code** CLI additionally receives `--disallowedTools`, so the denial reaches its native tools. Pi-native honors the list for built-ins and policy-gated app-owned tools. Direct Codex has no corresponding native denylist boundary, so configurations containing `disallowedTools` are rejected rather than partially enforced.

:::caution
**Known limitation — external MCP tools on pi.** Arbitrary tools advertised by an external MCP server are **not** deny-filtered on the pi-native runtime yet. Listing such a tool in `disallowedTools` has no effect there. To hard-restrict an external MCP tool on pi, **don't declare its server** in `mcp.json` / `tools.mcpServers` — server declaration, not the denylist, is what governs its availability. (The app-owned adapter send tools are exempt from this limitation: they are gated by the app, so their `disallowedTools` entries are honored everywhere.)
:::

## Built-in tool names

These are the names recognized for built-in runtime tools (coverage: `config`, gated by this policy):

Managed built-ins: `Read`, `Write`, `Edit`, `Glob`, `Grep`, `Bash`, `NodeRepl`, `WebFetch`, `WebSearch`. They are supplied through the Pi bridge; provider-owned routes use their documented native tool surfaces.

`NodeRepl` evaluates JavaScript in one REPL child per run. Code run by `Bash` or `NodeRepl` is further constrained by the [sandbox](/tools/sandbox/) (filesystem scopes and network policy) when `sandbox.mode` is `native`. The allowlist controls *whether* a tool exists; the sandbox controls *what it can reach*. See [Tools and guards](/runtime/tools-and-guards/#noderepl).

## Adapter send tools

The app can expose MCP tools that send messages back out through an already-enabled channel adapter: `SlackSendMessage`, `TelegramSendMessage` (optionally with non-blocking reply buttons), `TelegramSendFile` (document or photo), and one structured `AskUser` tool across web, Slack, and Telegram (coverage: `config`).

Under **allow-all** these are available automatically once the matching channel is enabled — you do not add them to any list. They only need an explicit `allowedTools` entry when you switch to a hand-picked allowlist: in that case, add the exact tool name **in addition** to valid `slack.*` / `telegram.*` adapter config. Either way, `disallowedTools` can remove them.

```json
{
  "tools": {
    "allowedTools": ["Read", "Grep", "SlackSendMessage", "TelegramSendMessage"]
  }
}
```

:::note
The adapter's own allowlist (channels/chats it may post to) remains the destination boundary — allowing the tool does not widen where messages can go. See [Delivery and send tools](/channels/delivery-and-send-tools/), [Slack](/channels/slack/), and [Telegram](/channels/telegram/).
:::

## RunHistory

`RunHistory` is an app-owned, read-only, request-scoped MCP tool for listing, searching, and cursor-inspecting safe normalized evidence from completed prior runs in the logical current conversation. Configured daily rollover buckets do not partition that scope. It has no separate config key:

- Under allow-all, it is available automatically on MCP-capable routes.
- Under a specific allowlist, include `RunHistory` explicitly.
- `disallowedTools` can remove it, with deny still winning.
- `run_history` is accepted only as a deprecated policy alias; the registered/model-facing name is `RunHistory`. Tool input also accepts `run_id` as an alias for `runId`.
- Direct OpenCode and other MCP-incompatible routes suppress it.

The tool excludes the current/running run, unrelated conversations or threads, system prompts, reasoning, recalled memory, and raw artifact paths. See [MCP servers](/tools/mcp/#runhistory-prior-run-evidence) for its list/search/overview/timeline interface and [Artifacts and traces](/observability/artifacts-and-traces/#agent-facing-prior-run-evidence-runhistory) for its evidence boundary.

## Tools not gated by allowedTools

Two families are never gated by `allowedTools` and are unaffected by the allow-all / specific-list choice:

- **`MemoryRecall`** — auto-provisioned from `config.memory.recallTool.enabled`. See [Capture & recall](/memory/capture-and-recall/).
- **MCP-server tools** (`mcp__…`) — governed by whether their server is declared, not by the allowlist. See below and [MCP servers](/tools/mcp/).

## MCP tools

MCP servers are configured alongside the policy via `tools.mcpServers` (inline) or `tools.mcpConfigPath` (a path to a JSON file). Their tools are always available once the server is declared; the allowlist neither adds nor removes them (and on pi the denylist can't either — see the known limitation above). See [MCP servers](/tools/mcp/) for the server configuration shape.

## Environment overrides

The allow/deny lists can be supplied via environment variables (coverage: `config`):

| Env var | Maps to |
| --- | --- |
| `MONO_AGENT_ALLOWED_TOOLS` | `tools.allowedTools` |
| `MONO_AGENT_DISALLOWED_TOOLS` | `tools.disallowedTools` |

The same rules apply through the environment: an **unset** `MONO_AGENT_ALLOWED_TOOLS` keeps the allow-all default, while an empty value (`MONO_AGENT_ALLOWED_TOOLS=""`) requests explicit chat-only `[]`. That request is valid on Pi/Claude SDK and rejected on direct Codex, direct OpenCode, and Claude Code CLI because those boundaries cannot enforce it. Deny-wins / overlap-rejection are otherwise unchanged. See [Environment variables](/config/env-vars/).

## Back-compat: legacy tool names

Most tools were renamed to PascalCase, and the remaining snake_case send/file,
skill, memory, and run-history spellings continue as deprecated policy-input
aliases. Mono-agent cannot safely rewrite hand-authored deny-lists, so those
entries must not silently stop matching. `telegram_send_document` and
`telegram_send_photo` both map to the single `TelegramSendFile` tool, so a
`disallowedTools` entry for either name denies the whole file tool. Canonical
PascalCase names are the only ones registered, emitted, or recommended. See
[Presets & modules](/reference/presets/#back-compat-legacy-tool-names) and the
canonical [deprecation tracker](/reference/deprecations/).

## Programmatic use

The policy is also available as a library for code-defined agents: `createToolPolicy()`, `failClosedToolPolicy()`, `loadToolPolicyFromJsonFile()`, and `toolPolicyToRuntimeOptions()` from `@mono-agent/agent-harness`. Errors are thrown as `ToolPolicyError` with codes `invalid_tool_policy` and `tool_policy_read_failed`. See [Programmatic API](/programmatic/).
